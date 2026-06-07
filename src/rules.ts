/**
 * Rules layer — "told once, never re-explained".
 *
 * Aggregates the `rules` sections harvested from every card into per-project
 * rules files with provenance, so the tier-0 injection can put standing user
 * instructions in front of the agent's eyes EVERY session — not behind search.
 *
 * v1 is deterministic (normalize + near-dup collapse, newest phrasing wins).
 * LLM curation (merge paraphrases, drop obsolete) is a later pass — and the
 * user can hand-edit the generated files; hand edits are preserved via the
 * PINNED section, which the generator never touches.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardData } from "./extractor.js";
import type { SessionMeta } from "./types.js";

interface RuleEntry {
  text: string;
  cardId: string;
  project: string;
  date: string;
}

const GENERATED_HEADER = "<!-- GENERATED below this line — edit the PINNED section only -->";

/** Crude near-dup key: lowercase, strip punctuation, first 9 significant words. */
function dupKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 9)
    .join(" ");
}

/** Harness noise the extractor sometimes mislabels as user rules. */
const NOISE_RE = /local-command|command-message|caveat|system-reminder|harness/i;

export async function aggregateRules(scopeDir: string): Promise<Map<string, RuleEntry[]>> {
  const raw = await readFile(join(scopeDir, "index.jsonl"), "utf8").catch(() => "");
  const metaById = new Map<string, SessionMeta>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = JSON.parse(line) as SessionMeta;
    metaById.set(m.id, m);
  }
  const { cardId } = await import("./cards.js");
  const byProject = new Map<string, RuleEntry[]>();
  for (const meta of metaById.values()) {
    const id = cardId(meta);
    let card: CardData;
    try {
      card = (JSON.parse(await readFile(join(scopeDir, "cards", `${id}.json`), "utf8")) as { data: CardData }).data;
    } catch {
      continue;
    }
    for (const r of card.rules) {
      if (NOISE_RE.test(r.text)) continue;
      const list = byProject.get(meta.project) ?? [];
      list.push({ text: r.text, cardId: id, project: meta.project, date: meta.startedAt?.slice(0, 10) ?? "" });
      byProject.set(meta.project, list);
    }
  }
  // collapse near-dups, newest phrasing wins
  for (const [project, list] of byProject) {
    const seen = new Map<string, RuleEntry>();
    for (const r of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
      seen.set(dupKey(r.text), r); // later (newer) overwrites
    }
    byProject.set(project, [...seen.values()].sort((a, b) => b.date.localeCompare(a.date)));
  }
  return byProject;
}

/**
 * Optional LLM curation: classify each rule as durable (preference, always
 * applies), state (true-when-said project fact — dated, may go stale), or
 * noise. Cached by rule dupKey in rules/.curation.json so repeat runs only
 * judge NEW rules. Falls back to "durable" on any engine failure (missing a
 * real rule is worse than carrying a stale one).
 */
async function curationFor(
  scopeDir: string,
  project: string,
  rules: RuleEntry[],
): Promise<Map<string, "durable" | "state" | "noise">> {
  const cachePath = join(scopeDir, "rules", ".curation.json");
  const cache = JSON.parse(await readFile(cachePath, "utf8").catch(() => "{}")) as Record<string, string>;
  const result = new Map<string, "durable" | "state" | "noise">();
  const unjudged: RuleEntry[] = [];
  for (const r of rules) {
    const cached = cache[dupKey(r.text)];
    if (cached === "durable" || cached === "state" || cached === "noise") result.set(dupKey(r.text), cached);
    else unjudged.push(r);
  }
  if (unjudged.length) {
    try {
      const { codexStructured } = await import("./extractor.js");
      const schemaPath = join(scopeDir, "..", "..", "schema", "curated-rules.schema.json");
      const prompt = `Classify each rule harvested from coding sessions for project "${project}".
- "durable": a standing user preference or working method that applies to FUTURE sessions
  regardless of project state (e.g. "terse PR descriptions", "verify, don't assume").
- "state": a project fact true when stated but tied to a moment (specific config values,
  current platform lists, "use X for now") — useful but dated.
- "noise": harness mechanics, one-off task instructions with no future value.
Return one entry per index.

RULES:
${unjudged.map((r, i) => `[${i}] ${r.text}`).join("\n")}`;
      const verdict = await codexStructured<{ rules: { index: number; kind: "durable" | "state" | "noise" }[] }>(
        prompt,
        schemaPath,
      );
      for (const v of verdict.rules) {
        const r = unjudged[v.index];
        if (r) {
          result.set(dupKey(r.text), v.kind);
          cache[dupKey(r.text)] = v.kind;
        }
      }
    } catch {
      for (const r of unjudged) result.set(dupKey(r.text), "durable"); // fail-open
    }
    await writeFile(cachePath, JSON.stringify(cache, null, 1)).catch(() => {});
  }
  return result;
}

/** Write store/<scope>/rules/<project>.md, preserving any hand-PINNED section. */
export async function writeRulesFiles(
  scopeDir: string,
  opts: { curate?: boolean } = {},
): Promise<{ projects: number; rules: number }> {
  const byProject = await aggregateRules(scopeDir);
  const dir = join(scopeDir, "rules");
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  let total = 0;
  for (const [project, rules] of byProject) {
    const path = join(dir, `${project.replace(/[^\w.-]/g, "_")}.md`);
    const existing = await readFile(path, "utf8").catch(() => "");
    const pinned = existing.includes(GENERATED_HEADER)
      ? existing.slice(0, existing.indexOf(GENERATED_HEADER)).trimEnd()
      : "## PINNED (hand-edited, never regenerated)\n";
    const fmt = (r: RuleEntry) => `- ${r.text}  *(from [[${r.cardId}]], ${r.date})*`;
    let generated: string;
    if (opts.curate) {
      const kinds = await curationFor(scopeDir, project, rules);
      const durable = rules.filter((r) => (kinds.get(dupKey(r.text)) ?? "durable") === "durable");
      const state = rules.filter((r) => kinds.get(dupKey(r.text)) === "state");
      generated =
        `## Standing preferences (durable — always apply)\n${durable.map(fmt).join("\n") || "- (none yet)"}\n\n` +
        `## Project state (true when said — check dates before trusting)\n${state.map(fmt).join("\n") || "- (none)"}`;
      total += durable.length + state.length;
    } else {
      generated = `## Observed rules (auto-harvested)\n${rules.map(fmt).join("\n")}`;
      total += rules.length;
    }
    await writeFile(path, `${pinned}\n\n${GENERATED_HEADER}\n\n${generated}\n`);
  }
  return { projects: byProject.size, rules: total };
}

/** Compact rules block for tier-0 injection: project rules + hand-pinned lines. */
export async function rulesForInjection(scopeDir: string, project: string, maxRules = 10): Promise<string[]> {
  const path = join(scopeDir, "rules", `${project.replace(/[^\w.-]/g, "_")}.md`);
  const content = await readFile(path, "utf8").catch(() => "");
  if (!content) return [];
  return content
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(0, maxRules)
    .map((l) => l.replace(/\s*\*\(from.*\)\*\s*$/, "")); // strip provenance for compactness
}

/** Pinned notes: agent/user "sticky notes" — appended, never auto-rewritten. */
export async function pinNote(scopeDir: string, project: string, note: string, source: string): Promise<string> {
  const dir = join(scopeDir, "notes");
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  const path = join(dir, `${project.replace(/[^\w.-]/g, "_")}.md`);
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- ${note}  *(pinned ${stamp} by ${source})*\n`;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, line);
  return path;
}

export async function notesForInjection(scopeDir: string, project: string, maxNotes = 8): Promise<string[]> {
  const path = join(scopeDir, "notes", `${project.replace(/[^\w.-]/g, "_")}.md`);
  const content = await readFile(path, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(-maxNotes); // newest last → take the tail
}

export async function listRuleProjects(scopeDir: string): Promise<string[]> {
  return (await readdir(join(scopeDir, "rules")).catch(() => [])).map((f) => f.replace(/\.md$/, ""));
}
