/**
 * Linker v1 — HIGH-PRECISION auto-edges only (a wrong edge misleads agents,
 * which is worse than no edge). Within-scope only; cross-scope is disallowed
 * by design (privacy partition).
 *
 *   relates-to:  same scope AND (≥2 shared real files, OR same project with
 *                ≥3 shared non-generic entities)
 *   supersedes:  same project AND later date AND explicit continuity signal
 *                in the later session ("handoff", "continued", "pick up where
 *                we left off") AND at least one relates-to-grade overlap.
 *                Verified ground truth: the glow-up handoff-brief chains.
 *
 * Rich semantic edges (follows-up, same-bug-as) are v2.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cardId as cardIdOf } from "./cards.js";
import { claudeProjectsDir } from "./config.js";
import type { CardData } from "./extractor.js";
import type { SessionMeta } from "./types.js";

export interface CardEdges {
  /** Each "<cardId>|<why>" — why is a mechanical overlap reason, e.g.
   * "3 shared files" or "4 shared entities". Lets an agent judge an edge
   * without paying to open the other card. */
  relatesTo: string[];
  supersedes: string[];
  supersededBy: string[];
}

// Exported so the dedup/consolidation pass (dedup.ts) can reuse the exact same
// loaded-and-filtered node shape (real files, stoplisted entities) — keeping a
// single definition of "what a card looks like to the graph layer".
export interface Node {
  cardId: string;
  meta: SessionMeta;
  card?: CardData;
  files: Set<string>;
  entities: Set<string>;
  date: string;
}

const ENTITY_STOPLIST = new Set([
  "wix", "npm", "npx", "node", "claude code", "claude", "github", "git",
  "glow-up", "glow up", "typescript", "javascript", "react", "yarn",
]);

// Transcript/memory files live under the Claude Code projects root (config-driven).
const CLAUDE_PROJECTS_ROOT = claudeProjectsDir();
/** Memory/index files are shared by most sessions in a project — not signal. */
function isRealFile(path: string): boolean {
  return !path.startsWith(CLAUDE_PROJECTS_ROOT) && !path.endsWith("MEMORY.md");
}

const CONTINUITY_RE = /handoff|continued|continuing|pick(?:s|ing)? up where|left off/i;

export async function loadNodes(scopeDir: string): Promise<Node[]> {
  const raw = await readFile(join(scopeDir, "index.jsonl"), "utf8").catch(() => "");
  const nodes: Node[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const meta = JSON.parse(line) as SessionMeta;
    const cardId = cardIdOf(meta);
    let card: CardData | undefined;
    try {
      card = (JSON.parse(await readFile(join(scopeDir, "cards", `${cardId}.json`), "utf8")) as { data: CardData }).data;
    } catch { /* index-only */ }
    nodes.push({
      cardId,
      meta,
      card,
      files: new Set(meta.filesTouched.filter(isRealFile)),
      entities: new Set(
        (card?.entities ?? []).map((e) => e.toLowerCase().trim()).filter((e) => e.length > 2 && !ENTITY_STOPLIST.has(e)),
      ),
      date: meta.startedAt ?? "",
    });
  }
  return nodes;
}

function intersect<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

export function computeEdges(nodes: Node[]): Map<string, CardEdges> {
  const edges = new Map<string, CardEdges>(
    nodes.map((n) => [n.cardId, { relatesTo: [], supersedes: [], supersededBy: [] }]),
  );
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      const sharedFiles = intersect(a.files, b.files);
      const sharedEntities = a.meta.project === b.meta.project ? intersect(a.entities, b.entities) : 0;
      const related = sharedFiles >= 2 || sharedEntities >= 3;
      if (!related) continue;
      const score = sharedFiles * 2 + sharedEntities;
      const why = [
        sharedFiles ? `${sharedFiles} shared file${sharedFiles > 1 ? "s" : ""}` : "",
        sharedEntities ? `${sharedEntities} shared entit${sharedEntities > 1 ? "ies" : "y"}` : "",
      ].filter(Boolean).join(", ");
      // encode score|why; score is used only for sorting, then stripped
      edges.get(a.cardId)!.relatesTo.push(`${b.cardId}|${score}|${why}`);
      edges.get(b.cardId)!.relatesTo.push(`${a.cardId}|${score}|${why}`);
      // supersedes: later node with explicit continuity signal
      const [earlier, later] = a.date <= b.date ? [a, b] : [b, a];
      const laterText = `${later.meta.title} ${later.card?.intent ?? ""}`;
      if (later.meta.project === earlier.meta.project && CONTINUITY_RE.test(laterText) && later.date !== earlier.date) {
        edges.get(later.cardId)!.supersedes.push(earlier.cardId);
        edges.get(earlier.cardId)!.supersededBy.push(later.cardId);
      }
    }
  }
  // keep top-5 relates-to by overlap score, strip score but KEEP the why
  for (const e of edges.values()) {
    e.relatesTo = [...new Set(e.relatesTo)]
      .sort((x, y) => Number(y.split("|")[1]) - Number(x.split("|")[1]))
      .slice(0, 5)
      .map((s) => {
        const [id, , why] = s.split("|");
        return why ? `${id}|${why}` : id!;
      });
    e.supersedes = [...new Set(e.supersedes)];
    e.supersededBy = [...new Set(e.supersededBy)];
  }
  return edges;
}
