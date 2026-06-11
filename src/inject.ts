/**
 * SessionStart context assembler — the tier-0 PUSH, made cheap.
 *
 * `inject()` in cli.ts used to concatenate every section UNBOUNDED (rules +
 * facts + notes + recent sessions). For a tool whose whole edge is being
 * lightweight, an unbounded push is the wrong default: it bloats context the
 * moment a project accumulates memory. This module turns that concatenation
 * into a TOKEN-BUDGETED, FRESHNESS-WEIGHTED, TIERED assembler.
 *
 * Design:
 *  - TIERS, in priority order (highest budget claim first):
 *      1. Pinned notes      — the user explicitly said "remember this"
 *      2. Standing rules     — what the user already told us; do NOT re-ask
 *      3. Durable facts      — decisions/rationale; age better than code
 *      4. Recent sessions    — recency feed; lowest trust, freshness-weighted
 *  - BUDGET: fill up to ~N tokens (estimated chars/4, the usual rough rule).
 *    Higher tiers are placed whole when they fit; lower tiers TRUNCATE (drop
 *    trailing lines) to fit the remaining budget. We never exceed the budget,
 *    and a tier that can't fit even its heading is dropped entirely.
 *  - FRESHNESS (recent tier): the caller pre-validates each recent row against
 *    current code (validate.ts). `broken` rows are DROPPED here — their code
 *    moved, so asserting them at session start would mislead. `stale` rows are
 *    kept but flagged. This is the differentiator: neither competitor validates
 *    pushed memory against the actual code.
 *  - Output shape is preserved byte-for-byte with the old inject(): same
 *    "# links: memory for this project" heading and the same section headings,
 *    so the SessionStart hook stays compatible. Nothing to show => "" (the
 *    caller prints nothing — cost zero).
 *
 * The assembler is a pure function (no IO) so the budget/tiering/drop logic is
 * trivially unit-testable; cli.ts does the IO (db read + validateCard) and hands
 * the already-shaped tiers in.
 */

/** Rough token estimate. The standard chars/4 heuristic — good enough to keep a
 *  push bounded; we round UP so we never under-count and overshoot the budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type Freshness = "fresh" | "stale" | "broken" | "unknown";

/** One recent-session row, already validated against current code by the caller. */
export interface RecentRow {
  /** The rendered line WITHOUT any freshness flag (caller builds the base text). */
  line: string;
  /** Per-card freshness verdict (validate.ts). Drives drop/flag here. */
  freshness: Freshness;
}

export interface InjectionTiers {
  /** Tier 1 — pinned notes (highest priority). */
  notes: string[];
  /** Tier 2 — standing rules. */
  rules: string[];
  /** Tier 3 — durable facts & decisions. */
  facts: string[];
  /** Tier 4 — recent sessions (lowest priority; freshness-weighted). */
  recent: RecentRow[];
}

export interface BuildInjectionOptions {
  /** Token budget for the whole block (heading + sections). */
  budgetTokens: number;
  /** Scope name — woven into the recent-tier "use links-<scope> MCP" pointer. */
  scope: string;
}

const HEADING = "# links: memory for this project";

/**
 * Assemble the bounded, tiered, freshness-weighted push block.
 *
 * Returns "" when there is nothing worth showing (so the caller prints nothing —
 * cost zero), exactly like the old inject().
 */
export function buildInjection(tiers: InjectionTiers, opts: BuildInjectionOptions): string {
  const { budgetTokens, scope } = opts;

  // Freshness-weight the recent tier BEFORE budgeting: broken rows are dropped
  // (their code moved — don't assert them), stale rows kept-but-flagged, fresh
  // kept clean. This is the differentiator vs. competitors that push unvalidated.
  const recentLines = tiers.recent
    .filter((r) => r.freshness !== "broken")
    .map((r) => (r.freshness === "stale" ? `${r.line}  [⚠ stale]` : r.line));

  // Build each tier as a (heading, body-lines) pair, in PRIORITY order. The
  // recent tier's heading carries the MCP usage pointer the old inject() printed.
  const recentPointer =
    `Before re-investigating anything, check if it was already solved: ` +
    `use links-${scope} MCP (search → get_card → read_session with msg ranges). Pin durable facts with pin_note.`;
  const sections: { heading: string; lines: string[]; preamble?: string }[] = [
    { heading: "## Pinned notes", lines: tiers.notes },
    {
      heading: "## Standing rules the user already told you (do NOT make them re-explain)",
      lines: tiers.rules,
    },
    { heading: "## Durable facts & decisions (don't re-derive these)", lines: tiers.facts },
    {
      heading: `## Recent sessions (${recentLines.length})`,
      lines: recentLines,
      preamble: recentPointer,
    },
  ];

  // Greedy fill in priority order. The block heading is mandatory overhead; if a
  // tier's heading (+ preamble) alone won't fit the remaining budget, skip the
  // whole tier. Otherwise keep adding body lines until the next one would bust
  // the budget — that's the truncation (trailing lines dropped) the spec asks for.
  let used = estimateTokens(HEADING);
  const rendered: string[] = [];

  for (const sec of sections) {
    if (!sec.lines.length) continue; // empty tier — nothing to place
    const head = sec.preamble ? `${sec.heading}\n${sec.preamble}` : sec.heading;
    // "\n\n" between blocks + "\n" before each line — count the separators so the
    // estimate matches the final joined string and we genuinely stay under budget.
    const headCost = estimateTokens("\n\n" + head);
    if (used + headCost > budgetTokens) continue; // can't even afford the heading

    const kept: string[] = [];
    let secUsed = headCost;
    for (const line of sec.lines) {
      const lineCost = estimateTokens("\n" + line);
      if (used + secUsed + lineCost > budgetTokens) break; // truncate the rest
      kept.push(line);
      secUsed += lineCost;
    }
    if (!kept.length) continue; // heading fit but no body line did — drop the tier
    used += secUsed;
    rendered.push(`${head}\n${kept.join("\n")}`);
  }

  if (!rendered.length) return ""; // nothing fit / nothing relevant — cost zero
  return [HEADING, ...rendered].join("\n\n");
}
