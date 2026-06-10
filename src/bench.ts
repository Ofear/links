/**
 * Retrieval benchmark — the product metric, operationalized (benchmark/benchmark.md §protocol).
 *
 * Three numbers, per the design's main goal ("reach the answer in fewer tokens, with vs
 * without links"):
 *
 *   1. RECALL@k       — LongMemEval-style: is a ground-truth card in the top-k search
 *                       hits? Reported R@1/@3/@5 so we're comparable to agentmemory's
 *                       claimed 95.2% R@5.
 *   2. TOKENS A/B     — tokens-to-correct-answer WITH links (tier-1 hit + card, + slice if
 *                       needed) vs WITHOUT (naive full-transcript read / no memory). The
 *                       savings ratio is the headline.
 *   3. PASS/FAIL      — protocol gate: a positive question passes when its ground-truth
 *                       card is retrieved AND the card text alone answers it (judge);
 *                       a negative passes when nothing is judged as answering.
 *                       Phase-1 exit: ≥7/10 held-out pass, 0/5 negative false positives.
 *
 * Judge: codex (adversarial framing). The judge is the only step that calls an external
 * model. `--no-judge` skips it (recall@k + token math are free and deterministic) and
 * `--fixture` runs the whole thing offline against a tiny synthetic store with a
 * deterministic keyword judge — that's the green end-to-end proof that the wiring and the
 * token math are correct without spending a cent or touching the 42M-token corpus.
 *
 * Usage:
 *   tsx src/bench.ts                 # real store, all sets, codex judge
 *   tsx src/bench.ts heldout         # real store, one set
 *   tsx src/bench.ts --no-judge      # real store, recall@k + token math only (free)
 *   tsx src/bench.ts --fixture       # offline synthetic fixture, fully green, no codex
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { searchIndex, hybridSearch, rebuildScope, type IndexRow } from "./db.js";
import { cardId } from "./cards.js";
import { renderCard } from "./cards.js";
import { codexStructured, type CardData } from "./extractor.js";
import type { SessionMeta } from "./types.js";

const ROOT = join(import.meta.dirname, "..");
const VERDICT_SCHEMA = join(ROOT, "schema", "verdict.schema.json");
const TOP_K = 5;

// ----- token model (chars/4; same heuristic the card's est_full_read_tokens uses) -----
const CHARS_PER_TOKEN = 4;
const TIER1_TOKENS_PER_HIT = 30; // a compact index line (db.ts contract)
const tokensFromKb = (kb: number) => Math.max(1, Math.round((kb * 1024) / CHARS_PER_TOKEN));
const tokensFromChars = (chars: number) => Math.max(1, Math.round(chars / CHARS_PER_TOKEN));

interface Question {
  id: string;
  set: "tuning" | "heldout" | "negative";
  question: string;
  ground_truth: string[];
  /** fixture-only: deterministic offline judge passes if the card contains these. */
  expect_keywords?: string[];
}
interface Verdict {
  answered: boolean;
  reason: string;
}
type Hit = IndexRow & { scope: string };

interface QResult {
  id: string;
  set: string;
  pass: boolean;
  detail: string;
  /** rank (1-based) of the first ground-truth card among hits, or 0 if absent. */
  gtRank: number;
  /** tokens to reach a correct answer WITH links / WITHOUT links (positives only). */
  withTokens?: number;
  withoutTokens?: number;
}

// ---------------------------------------------------------------- judges
type Judge = (question: string, card: string, q: Question) => Promise<Verdict>;

/** Real judge — adversarial, codex-backed. The only external-model call in this file. */
const codexJudge: Judge = (question, card) =>
  codexStructured<Verdict>(judgePrompt(question, card), VERDICT_SCHEMA);

/** Offline fixture judge — deterministic, no network. Answers iff the card text contains
 *  the question's expected keywords (case-insensitive). Proves the wiring + math green. */
const keywordJudge: Judge = (_question, card, q) => {
  const lc = card.toLowerCase();
  const need = q.expect_keywords ?? [];
  const hits = need.filter((k) => lc.includes(k.toLowerCase()));
  const answered = need.length > 0 && hits.length >= Math.ceil(need.length / 2);
  return Promise.resolve({
    answered,
    reason: answered
      ? `card contains ${hits.length}/${need.length} expected keywords [${hits.join(", ")}]`
      : `card missing expected keywords (found ${hits.length}/${need.length})`,
  });
};

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

// ---------------------------------------------------------------- store access
function makeStore(scopeDirs: { scope: string; dir: string }[], lexicalOnly = false) {
  // hybrid (FTS5 + vector fusion) is the real serving path; --lexical pins the old
  // FTS5-only path so we can measure whether hybrid actually lifts retrieval.
  const search = lexicalOnly ? searchIndex : hybridSearch;
  async function searchAll(query: string): Promise<Hit[]> {
    // searchIndex is sync, hybridSearch is async — await handles both uniformly
    const perScope = await Promise.all(
      scopeDirs.map(async ({ scope, dir }) =>
        (await search(dir, query, TOP_K)).map((h) => ({ ...h, scope })),
      ),
    );
    // interleave so neither scope monopolizes the budget; cap at the funnel width
    return perScope.flat().slice(0, TOP_K * scopeDirs.length);
  }
  async function loadCard(scope: string, id: string): Promise<string | null> {
    const dir = scopeDirs.find((s) => s.scope === scope)?.dir;
    if (!dir) return null;
    return readFile(join(dir, "cards", `${id}.md`), "utf8").catch(() => null);
  }
  return { searchAll, loadCard };
}

// ---------------------------------------------------------------- per-question scoring
async function scoreQuestion(
  q: Question,
  store: ReturnType<typeof makeStore>,
  judge: Judge,
  contaminated: string[],
  useJudge: boolean,
): Promise<QResult> {
  const hits = (await store.searchAll(q.question)).filter(
    (h) => !contaminated.some((c) => h.session_id.startsWith(c)),
  );

  // rank of first ground-truth card among carded hits (recall@k input)
  let gtRank = 0;
  for (let i = 0; i < hits.length; i++) {
    if (q.ground_truth.some((g) => hits[i]!.session_id.startsWith(g))) {
      gtRank = i + 1;
      break;
    }
  }

  if (q.set === "negative") {
    const top = hits.find((h) => h.has_card);
    if (!top) return { id: q.id, set: q.set, pass: true, detail: "no carded hits — correctly empty", gtRank: 0 };
    const card = await store.loadCard(top.scope, top.card_id);
    if (!useJudge) {
      // without a judge we can't confirm irrelevance from text; report the top hit so a
      // human can eyeball it. Recall@k is undefined for negatives.
      return { id: q.id, set: q.set, pass: true, detail: `top carded hit ${top.card_id} (judge skipped — eyeball)`, gtRank: 0 };
    }
    const v = await judge(q.question, card ?? top.intent, q);
    return {
      id: q.id, set: q.set, gtRank: 0, pass: !v.answered,
      detail: v.answered
        ? `FALSE POSITIVE: ${top.card_id} judged as answering — ${v.reason}`
        : `top hit ${top.card_id} correctly judged irrelevant — ${v.reason}`,
    };
  }

  // positive question --------------------------------------------------------
  const gtHit = gtRank ? hits[gtRank - 1]! : undefined;
  if (!gtHit) {
    return { id: q.id, set: q.set, pass: false, gtRank: 0, detail: `tier-1 MISS — ground truth not in top ${hits.length}: ${q.ground_truth.join(", ")}` };
  }
  const card = await store.loadCard(gtHit.scope, gtHit.card_id);
  if (!card) {
    return { id: q.id, set: q.set, pass: false, gtRank, detail: `tier-1 hit ${gtHit.card_id} (rank ${gtRank}) but card .md missing` };
  }

  // ---- tokens-to-correct-answer A/B -----------------------------------------
  // WITH links: read the gtRank index lines you scanned + the one card that answered.
  // (Realistic floor: an agent reads hits down to the one it opens, then opens it.)
  const withTokens = gtRank * TIER1_TOKENS_PER_HIT + tokensFromChars(card.length);
  // WITHOUT links: no memory → read the full transcript to re-derive the answer.
  const withoutTokens = tokensFromKb(gtHit.size_kb);

  const verdict = useJudge
    ? await judge(q.question, card, q)
    : ({ answered: true, reason: "judge skipped (--no-judge): retrieval+rank only" } as Verdict);

  const cheaper = withTokens < withoutTokens;
  const pass = verdict.answered && cheaper;
  return {
    id: q.id, set: q.set, gtRank, withTokens, withoutTokens, pass,
    detail: `rank ${gtRank}, ${verdict.answered ? "card answers" : "card insufficient"} — ${verdict.reason}; ` +
      `tokens ${withTokens} vs ${withoutTokens} (${(withoutTokens / withTokens).toFixed(0)}x ${cheaper ? "cheaper" : "MORE"})`,
  };
}

// ---------------------------------------------------------------- fixture builder
/** Build the offline synthetic store from benchmark/fixture/ using the REAL pipeline
 *  (renderCard + rebuildScope/searchIndex), so a green fixture proves the real wiring. */
async function buildFixtureStore(): Promise<{ scope: string; dir: string }[]> {
  const fxRoot = join(ROOT, "benchmark", "fixture");
  const scope = "demo";
  const dir = join(fxRoot, "store", scope);
  await mkdir(join(dir, "cards"), { recursive: true });

  const raw = await readFile(join(dir, "index.jsonl"), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const meta = JSON.parse(line) as SessionMeta;
    const id = cardId(meta);
    const jsonPath = join(dir, "cards", `${id}.json`);
    const { data } = JSON.parse(await readFile(jsonPath, "utf8")) as { data: CardData };
    // render the .md from the .json — same renderer production uses
    await writeFile(join(dir, "cards", `${id}.md`), renderCard(meta, data));
  }
  await rebuildScope(dir);
  return [{ scope, dir }];
}

// ---------------------------------------------------------------- report
function report(results: QResult[], heading: string): string {
  let out = `\n${"=".repeat(60)}\n${heading}\n${"=".repeat(60)}\n`;

  // ---- recall@k (positives only) ----
  const pos = results.filter((r) => r.set !== "negative");
  if (pos.length) {
    const rAt = (k: number) => pos.filter((r) => r.gtRank > 0 && r.gtRank <= k).length / pos.length;
    out += `\nRECALL@k (positive questions, n=${pos.length}):\n`;
    out += `  R@1 = ${(rAt(1) * 100).toFixed(1)}%   R@3 = ${(rAt(3) * 100).toFixed(1)}%   R@5 = ${(rAt(5) * 100).toFixed(1)}%\n`;
    out += `  (competitor agentmemory claims 95.2% R@5)\n`;
  }

  // ---- token A/B (positives that were retrieved) ----
  const withTok = pos.filter((r) => r.withTokens != null);
  if (withTok.length) {
    const sumWith = withTok.reduce((a, r) => a + (r.withTokens ?? 0), 0);
    const sumWithout = withTok.reduce((a, r) => a + (r.withoutTokens ?? 0), 0);
    out += `\nTOKENS-TO-CORRECT-ANSWER (retrieved positives, n=${withTok.length}):\n`;
    out += `  WITH links    = ${sumWith.toLocaleString()} tok total (avg ${Math.round(sumWith / withTok.length).toLocaleString()})\n`;
    out += `  WITHOUT links = ${sumWithout.toLocaleString()} tok total (avg ${Math.round(sumWithout / withTok.length).toLocaleString()})\n`;
    out += `  → ${(sumWithout / sumWith).toFixed(0)}x fewer tokens with links (${(100 * (1 - sumWith / sumWithout)).toFixed(1)}% saved)\n`;
  }

  // ---- pass/fail per set ----
  for (const set of ["tuning", "heldout", "negative"]) {
    const rs = results.filter((r) => r.set === set);
    if (!rs.length) continue;
    out += `\n${set.toUpperCase()} — ${rs.filter((r) => r.pass).length}/${rs.length} pass\n`;
    for (const r of rs) out += `  ${r.pass ? "✓" : "✗"} ${r.id}: ${r.detail}\n`;
  }

  // ---- protocol gate ----
  const heldout = results.filter((r) => r.set === "heldout");
  const negatives = results.filter((r) => r.set === "negative");
  if (heldout.length || negatives.length) {
    const hoPass = heldout.filter((r) => r.pass).length;
    const falsePos = negatives.filter((r) => !r.pass).length;
    const hoGate = heldout.length ? hoPass >= Math.ceil(0.7 * heldout.length) : true;
    const negGate = falsePos === 0;
    out += `\nPHASE-1 EXIT GATE:\n`;
    out += `  held-out  ${hoPass}/${heldout.length} pass (need ≥${Math.ceil(0.7 * heldout.length)})  ${hoGate ? "✓" : "✗"}\n`;
    out += `  negative  ${falsePos} false positives (need 0)  ${negGate ? "✓" : "✗"}\n`;
    out += `  ⇒ ${hoGate && negGate ? "GATE PASSED" : "GATE NOT PASSED"}\n`;
  }
  return out;
}

// ---------------------------------------------------------------- main
async function main(argv: string[]) {
  const fixture = argv.includes("--fixture");
  const useJudge = !argv.includes("--no-judge");
  const lexicalOnly = argv.includes("--lexical"); // pin FTS5-only path for A/B vs hybrid
  const setFilter = argv.find((a) => ["tuning", "heldout", "negative", "paraphrase"].includes(a));

  const specPath = fixture
    ? join(ROOT, "benchmark", "fixture", "questions.json")
    : join(ROOT, "benchmark", "questions.json");
  const spec = JSON.parse(await readFile(specPath, "utf8")) as {
    contaminated: string[];
    questions: Question[];
  };
  const questions = spec.questions.filter((q) => !setFilter || q.set === setFilter);

  let store: ReturnType<typeof makeStore>;
  let judge: Judge;
  let judging = useJudge;
  if (fixture) {
    store = makeStore(await buildFixtureStore(), lexicalOnly);
    judge = keywordJudge;
    judging = true; // the keyword judge is free + offline, always run it
  } else {
    const { storeDir } = await import("./config.js");
    const scopeDirs = ["personal", "wix"]
      .map((scope) => ({ scope, dir: join(storeDir(), scope) }))
      .filter((s) => existsSync(s.dir));
    if (!scopeDirs.length) {
      console.error("no store/<scope> dirs found — run `npm run ingest` + extract first, or use --fixture");
      process.exit(2);
    }
    store = makeStore(scopeDirs, lexicalOnly);
    judge = codexJudge;
  }

  const results: QResult[] = [];
  for (const q of questions) {
    results.push(await scoreQuestion(q, store, judge, spec.contaminated ?? [], judging));
  }

  const retriever = lexicalOnly ? "lexical FTS5-only" : "hybrid (FTS5+vector)";
  const heading = fixture
    ? `links benchmark — OFFLINE FIXTURE [${retriever}] (synthetic store, deterministic judge, no codex)`
    : `links benchmark — REAL STORE [${retriever}]${useJudge ? "" : " (--no-judge: retrieval + token math only)"}`;
  console.log(report(results, heading).trimEnd());
}

await main(process.argv.slice(2));
