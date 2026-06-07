/**
 * Dedup / consolidation — workstream D, "defend the moat".
 *
 * PROBLEM (Phase 0 finding): scheduled/recurring agent runs produce near-duplicate
 * sessions → near-duplicate cards that pollute retrieval. The same nightly job
 * cards itself N times; an agent searching "did we solve X?" gets N identical hits
 * and burns its budget reading the same thing.
 *
 * mem0's model is ADD-only with hash + top-K-similarity dedup. `links` instead runs
 * a HIGH-PRECISION consolidation pass over the already-extracted cards. Cards are a
 * rebuildable cache, so this pass is derived, idempotent, and safe to re-run.
 *
 * GOVERNING RULE (DESIGN.md §main-goal corollary 3): a WRONG merge is worse than a
 * duplicate. Precision over coverage. We only collapse on strong, multi-signal
 * evidence; on weak evidence we LINK and leave both cards intact.
 *
 * ── Similarity signal (cheap, no LLM) ──────────────────────────────────────────
 *   1. File overlap  : Jaccard over files_touched (real files only — same
 *                      isRealFile filter the linker uses; memory/index files are
 *                      shared by everyone and carry no signal).
 *   2. Intent overlap: Jaccard over shingled (3-token) normalized intent+title text.
 *      Shingling (vs bag-of-words) is what distinguishes "fix the SMS bug" from
 *      "fix the auth bug" — order/phrasing-sensitive, still O(n) and LLM-free.
 *   Both must clear their bar; a pair that shares files but does totally different
 *   work (e.g. a big shared config touched for unrelated reasons) is NOT a dup.
 *
 * ── Conservative 3-way policy (per candidate pair, strongest first) ────────────
 *   COLLAPSE  exact/near-exact twins — same project, fileJaccard ≥ 0.9 AND
 *             intentJaccard ≥ 0.6 (or identical intent). The recurring-run case.
 *             Keep the NEWER card as canonical; the older becomes a duplicate-of
 *             pointer. Outcome guard: never collapse a "succeeded" into an
 *             "abandoned"/"partial" — that would hide a real result.
 *   SUPERSEDE continuity is clear — same project, strong file overlap, later date,
 *             AND the linker already drew a supersedes edge between them (explicit
 *             continuity signal). We don't re-derive continuity here; we defer to
 *             the linker's verified signal and just record the consolidation.
 *   LINK      everything above the relatedness floor but below the collapse bar.
 *             This is the safe default — no merge, just a relates-to-grade pointer
 *             (which the linker already emits). Dedup adds nothing destructive here.
 *
 * Anything below the floor: untouched, no decision.
 *
 * ── Output ─────────────────────────────────────────────────────────────────────
 * A DedupPlan: a list of DECISIONS, never a mutation. The plan is what gets
 * persisted (consolidation.json) and what the card renderer / search layer consult
 * to (a) hide collapsed duplicates from default search and (b) stamp the canonical
 * card with a "consolidates" note. Producing only a plan keeps this module pure and
 * trivially testable, and keeps the destructive step (if any) in one auditable place.
 *
 * INTEGRATION POINTS (documented, not wired here — see lane restriction):
 *   • src/cli.ts  `link()`  — after computeEdges, call:
 *         const plan = planDedup(nodes, edges);
 *         await writeFile(join(scopeDir, "consolidation.json"), JSON.stringify(plan, null, 1));
 *     (additive; reuses the `nodes` and `edges` already in scope.)
 *   • src/db.ts  `rebuildScope` / `searchIndex` — read consolidation.json and set a
 *     `superseded`/`duplicate` flag column so collapsed cards drop OUT of default
 *     search ranking (still reachable by id — cards are never deleted, per the
 *     "rank by recency, never delete" risk row in DESIGN.md).
 *   • src/cards.ts `renderCard` — when a card is a `canonical` with consolidates[],
 *     add a "## Consolidated\n- absorbs [[id]] (N duplicate runs)" note so an agent
 *     landing on it knows it represents a cluster.
 * None of those files are edited by this workstream; this module is the source of
 * truth they would consult.
 */
import type { CardEdges, Node } from "./linker.js";

// Thresholds — tuned conservatively. Raising COLLAPSE_* makes us merge less
// (safer); the floor governs only whether we bother recording a link decision.
export const COLLAPSE_FILE_JACCARD = 0.9;
export const COLLAPSE_INTENT_JACCARD = 0.6;
export const RELATED_FILE_JACCARD = 0.34; // ≈ 2/6 shared files — matches linker's ≥2-file relatedness in spirit
export const RELATED_INTENT_JACCARD = 0.3;
const SHINGLE_N = 3;

export type DedupAction = "collapse" | "supersede" | "link";

export interface DedupDecision {
  /** The card that survives as the entry point for the cluster. */
  canonical: string;
  /** The other card in the pair. For collapse it is hidden behind canonical;
   * for supersede/link it stays a first-class card. */
  other: string;
  action: DedupAction;
  fileJaccard: number;
  intentJaccard: number;
  /** Human-auditable reason — surfaced in consolidation.json for trust. */
  why: string;
}

export interface DedupPlan {
  decisions: DedupDecision[];
  /** card ids hidden from default search (collapsed duplicates only). Derived
   * convenience set so the search layer needn't re-walk decisions. */
  hidden: string[];
}

// ── text/normalization helpers (LLM-free) ──────────────────────────────────────

const TOKEN_STOP = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "with",
  "fix", "fixing", "fixed", "add", "adding", "update", "updating", "issue",
  "bug", "error", "make", "run", "session", "task",
]);

/** Lowercase, split on non-alphanumerics, drop short/stop tokens. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !TOKEN_STOP.has(t));
}

/** N-gram shingles over the token stream. Order-sensitive similarity without an LLM. */
function shingles(tokens: string[], n = SHINGLE_N): Set<string> {
  if (tokens.length < n) return new Set(tokens); // short intents: fall back to tokens
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(" "));
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size && !b.size) return 0; // two empties are NOT "identical" for our purposes — no evidence
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function intentText(n: Node): string {
  return `${n.card?.intent ?? ""} ${n.meta.title ?? ""}`.trim();
}

/** A "succeeded" result must never be hidden behind a non-succeeded one. */
function outcomeRank(n: Node): number {
  switch (n.card?.outcome) {
    case "succeeded": return 3;
    case "partial": return 2;
    case "abandoned": return 1;
    default: return 0; // unknown
  }
}

// ── core ────────────────────────────────────────────────────────────────────────

/**
 * Produce a consolidation plan over the loaded nodes. Pure and idempotent: same
 * nodes + edges → same plan. `edges` is the linker's output; we read its
 * supersedes relation to decide the SUPERSEDE action (we never re-derive
 * continuity — we trust the linker's explicit-signal gate).
 */
export function planDedup(nodes: Node[], edges?: Map<string, CardEdges>): DedupPlan {
  const decisions: DedupDecision[] = [];
  const hidden = new Set<string>();
  // index intent shingles once per node
  const shingleCache = new Map<string, Set<string>>();
  const shinglesOf = (n: Node) => {
    let s = shingleCache.get(n.cardId);
    if (!s) shingleCache.set(n.cardId, (s = shingles(tokenize(intentText(n)))));
    return s;
  };

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      // Only consolidate WITHIN a project — cross-project is never a duplicate by
      // construction (and cross-scope can't even reach here: separate stores).
      if (a.meta.project !== b.meta.project) continue;
      // Both must be real cards — index-only stubs have no intent to compare.
      if (!a.card || !b.card) continue;

      const fileJ = jaccard(a.files, b.files);
      const intentJ = jaccard(shinglesOf(a), shinglesOf(b));
      const identicalIntent = intentText(a).length > 0 && intentText(a) === intentText(b);

      // floor: must look related on BOTH axes (or be a near-perfect file twin) to
      // earn any decision. A coincidental single shared config file is below this.
      const related = (fileJ >= RELATED_FILE_JACCARD && intentJ >= RELATED_INTENT_JACCARD) || fileJ >= COLLAPSE_FILE_JACCARD;
      if (!related) continue;

      // canonical = newer card (date tiebreak: higher outcome, then id for determinism)
      const [newer, older] = pickCanonical(a, b);

      const collapse =
        fileJ >= COLLAPSE_FILE_JACCARD && (intentJ >= COLLAPSE_INTENT_JACCARD || identicalIntent);

      // GUARD: never hide a stronger-outcome card behind a weaker one. If the older
      // card succeeded and the newer didn't, downgrade to a LINK — we will not bury
      // a real result under a later failed/abandoned re-run.
      const wouldHideResult = collapse && outcomeRank(older) > outcomeRank(newer);

      // supersede only if the linker already drew the (explicit-signal) edge
      const linkerSupersedes =
        !!edges &&
        (edges.get(newer.cardId)?.supersedes.includes(older.cardId) ||
          edges.get(older.cardId)?.supersededBy.includes(newer.cardId));

      let action: DedupAction;
      let why: string;
      if (collapse && !wouldHideResult) {
        action = "collapse";
        why = `near-duplicate run: files ${fileJ.toFixed(2)} jaccard, intent ${identicalIntent ? "identical" : intentJ.toFixed(2)}; keep newer ${newer.cardId}`;
        hidden.add(older.cardId);
      } else if (linkerSupersedes) {
        action = "supersede";
        why = `continuity (linker supersedes edge); files ${fileJ.toFixed(2)} jaccard`;
      } else {
        action = "link";
        why = wouldHideResult
          ? `near-dup but newer card has weaker outcome (${older.card?.outcome} > ${newer.card?.outcome}) — linked, not collapsed`
          : `related but below collapse bar: files ${fileJ.toFixed(2)}, intent ${intentJ.toFixed(2)}`;
      }

      decisions.push({
        canonical: newer.cardId,
        other: older.cardId,
        action,
        fileJaccard: round2(fileJ),
        intentJaccard: round2(intentJ),
        why,
      });
    }
  }

  // A card collapsed under one canonical must not also be a canonical that hides
  // others (chains create ambiguity). Re-point: if X is hidden, any decision where
  // X is canonical degrades to a link (precision guard against transitive merges).
  for (const d of decisions) {
    if (d.action === "collapse" && hidden.has(d.canonical)) {
      d.action = "link";
      d.why = `${d.why} [demoted: canonical ${d.canonical} is itself collapsed elsewhere]`;
      hidden.delete(d.other); // it is no longer being hidden by this decision
    }
  }
  // recompute hidden from the post-adjustment collapse decisions (authoritative)
  const finalHidden = new Set<string>();
  for (const d of decisions) if (d.action === "collapse") finalHidden.add(d.other);

  // stable ordering for idempotent on-disk output
  decisions.sort((x, y) => (x.canonical + x.other).localeCompare(y.canonical + y.other));
  return { decisions, hidden: [...finalHidden].sort() };
}

function pickCanonical(a: Node, b: Node): [Node, Node] {
  // newer date wins; ties broken by outcome then cardId (fully deterministic)
  if (a.date !== b.date) return a.date > b.date ? [a, b] : [b, a];
  const ra = outcomeRank(a), rb = outcomeRank(b);
  if (ra !== rb) return ra > rb ? [a, b] : [b, a];
  return a.cardId > b.cardId ? [a, b] : [b, a];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
