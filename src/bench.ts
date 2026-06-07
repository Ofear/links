/**
 * Retrieval-funnel benchmark (the automatable half of benchmark.md's protocol).
 *
 * Per positive question:
 *   tier-1: does a ground-truth card appear in the top-K search hits? (both scopes)
 *   tier-2: judge (codex, adversarial framing) — does the card TEXT alone answer it?
 * Per negative question:
 *   pass = no hit judged as answering. False positives are the costly failure.
 *
 * The full agent-level A/B (tokens-to-correct-answer with vs without links) is
 * run manually on sampled questions — this runner is the fast, repeatable gate.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { searchIndex } from "./db.js";
import { codexStructured } from "./extractor.js";

const ROOT = join(import.meta.dirname, "..");
const VERDICT_SCHEMA = join(ROOT, "schema", "verdict.schema.json");
const TOP_K = 5;

interface Question {
  id: string;
  set: "tuning" | "heldout" | "negative";
  question: string;
  ground_truth: string[];
}
interface Verdict {
  answered: boolean;
  reason: string;
}

function judgePrompt(question: string, card: string): string {
  return `You are an adversarial judge for a session-memory benchmark. Decide whether the
metadata card below, BY ITSELF, gives a developer the substantive answer to the question.
Be strict: a card that merely mentions related topics does NOT answer. But do not demand
verbatim phrasing — if the card states the root cause / fix / explanation the question
asks for, that answers it. Output answered=true/false and a one-sentence reason.

QUESTION: ${question}

CARD:
${card}`;
}

async function loadCard(scope: string, cardId: string): Promise<string | null> {
  return readFile(join(ROOT, "store", scope, "cards", `${cardId}.md`), "utf8").catch(() => null);
}

function searchBothScopes(query: string) {
  const hits = [
    ...searchIndex(join(ROOT, "store", "personal"), query, TOP_K).map((h) => ({ ...h, scope: "personal" })),
    ...searchIndex(join(ROOT, "store", "wix"), query, TOP_K).map((h) => ({ ...h, scope: "wix" })),
  ];
  return hits.slice(0, TOP_K * 2);
}

async function main(filterSet?: string) {
  const spec = JSON.parse(await readFile(join(ROOT, "benchmark", "questions.json"), "utf8")) as {
    contaminated: string[];
    questions: Question[];
  };
  const questions = spec.questions.filter((q) => !filterSet || q.set === filterSet);
  const results: { id: string; set: string; pass: boolean; detail: string }[] = [];

  for (const q of questions) {
    const hits = searchBothScopes(q.question).filter(
      (h) => !spec.contaminated.some((c) => h.session_id.startsWith(c)),
    );
    if (q.set === "negative") {
      // pass if no hit's card claims to answer; only judge the top hit with a card
      const top = hits.find((h) => h.has_card);
      if (!top) {
        results.push({ id: q.id, set: q.set, pass: true, detail: "no carded hits — correctly empty" });
        continue;
      }
      const card = await loadCard(top.scope, top.card_id);
      const v = await codexStructured<Verdict>(judgePrompt(q.question, card ?? top.intent), VERDICT_SCHEMA);
      results.push({
        id: q.id, set: q.set, pass: !v.answered,
        detail: v.answered ? `FALSE POSITIVE: ${top.card_id} judged as answering — ${v.reason}` : `top hit ${top.card_id} correctly judged irrelevant`,
      });
      continue;
    }
    // positive question
    const gtHit = hits.find((h) => q.ground_truth.some((g) => h.session_id.startsWith(g)));
    if (!gtHit) {
      const carded = await Promise.all(
        q.ground_truth.map(async (g) => {
          const inAnyScope =
            (await loadCardBySession(g, "personal")) ?? (await loadCardBySession(g, "wix"));
          return inAnyScope ? g : `${g}(no card yet)`;
        }),
      );
      results.push({ id: q.id, set: q.set, pass: false, detail: `tier-1 MISS — ground truth not in top ${TOP_K * 2}: ${carded.join(", ")}` });
      continue;
    }
    const card = await loadCard(gtHit.scope, gtHit.card_id);
    if (!card) {
      results.push({ id: q.id, set: q.set, pass: false, detail: `tier-1 hit ${gtHit.card_id} but card not extracted yet` });
      continue;
    }
    const v = await codexStructured<Verdict>(judgePrompt(q.question, card), VERDICT_SCHEMA);
    results.push({
      id: q.id, set: q.set, pass: v.answered,
      detail: v.answered ? `tier-1 rank ok, card answers — ${v.reason}` : `tier-1 ok but card insufficient — ${v.reason}`,
    });
  }

  // -------- report --------
  let out = "";
  for (const set of ["tuning", "heldout", "negative"]) {
    const rs = results.filter((r) => r.set === set);
    if (!rs.length) continue;
    out += `\n${set.toUpperCase()} — ${rs.filter((r) => r.pass).length}/${rs.length} pass\n`;
    for (const r of rs) out += `  ${r.pass ? "✓" : "✗"} ${r.id}: ${r.detail}\n`;
  }
  console.log(out.trim());
}

async function loadCardBySession(sessionPrefix: string, scope: string): Promise<string | null> {
  const { cardId } = await import("./cards.js");
  const raw = await readFile(join(ROOT, "store", scope, "index.jsonl"), "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = JSON.parse(line) as { id: string; startedAt?: string; tool: "claude-code" };
    if (m.id.startsWith(sessionPrefix)) return loadCard(scope, cardId(m));
  }
  return null;
}

await main(process.argv[2]);
