/** Run: npx tsx src/inject.test.ts — exits non-zero on any failure.
 *  Covers the pure assembler: tiering, token budget/truncation, broken-drop,
 *  stale-flag, and the cost-zero empty case. */
import { buildInjection, estimateTokens, type InjectionTiers } from "./inject.js";

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}${detail ? ` → ${detail}` : ""}`);
    failed++;
  }
}

const HEAD = "# links: memory for this project";
const BIG = 100000; // effectively unbounded

// ---- empty → cost zero ----
check(
  "empty tiers → empty string (cost zero)",
  buildInjection({ notes: [], rules: [], facts: [], recent: [] }, { budgetTokens: BIG, scope: "personal" }) === "",
);

// ---- ordering: pinned notes → rules → facts → recent ----
const all: InjectionTiers = {
  notes: ["- note A"],
  rules: ["- rule A"],
  facts: ["- fact A"],
  recent: [{ line: "- recent A", freshness: "fresh" }],
};
const full = buildInjection(all, { budgetTokens: BIG, scope: "personal" });
check("output starts with the project heading", full.startsWith(HEAD));
const iNotes = full.indexOf("## Pinned notes");
const iRules = full.indexOf("## Standing rules");
const iFacts = full.indexOf("## Durable facts");
const iRecent = full.indexOf("## Recent sessions");
check("section order is notes < rules < facts < recent", iNotes < iRules && iRules < iFacts && iFacts < iRecent,
  `${iNotes},${iRules},${iFacts},${iRecent}`);
check("recent section keeps the MCP pointer + scope", full.includes("use links-personal MCP"));

// ---- freshness: broken dropped, stale flagged, fresh clean ----
const fresh: InjectionTiers = {
  notes: [], rules: [], facts: [],
  recent: [
    { line: "- card-fresh", freshness: "fresh" },
    { line: "- card-stale", freshness: "stale" },
    { line: "- card-broken", freshness: "broken" },
    { line: "- card-unknown", freshness: "unknown" },
  ],
};
const fr = buildInjection(fresh, { budgetTokens: BIG, scope: "x" });
check("broken recent row is DROPPED", !fr.includes("card-broken"));
check("stale recent row kept + flagged [⚠ stale]", fr.includes("- card-stale  [⚠ stale]"));
check("fresh recent row kept clean (no flag)", fr.includes("- card-fresh\n") || fr.endsWith("- card-fresh") || fr.includes("- card-fresh"));
check("fresh row has no stale flag", !fr.includes("card-fresh  [⚠"));
check("unknown recent row kept clean", fr.includes("- card-unknown") && !fr.includes("card-unknown  ["));
check("recent count reflects post-drop size (3, not 4)", fr.includes("## Recent sessions (3)"), fr);

// ---- budget: never exceeds, and stays under within the chars/4 estimate ----
const long = (n: number) => "- " + "x".repeat(n);
const many: InjectionTiers = {
  notes: [long(40)],
  rules: [long(40)],
  facts: [long(40)],
  recent: Array.from({ length: 50 }, (_, i) => ({ line: long(60) + i, freshness: "fresh" as const })),
};
const tinyBudget = 120;
const bounded = buildInjection(many, { budgetTokens: tinyBudget, scope: "personal" });
check("output never exceeds budget (estimated)", estimateTokens(bounded) <= tinyBudget,
  `est=${estimateTokens(bounded)} budget=${tinyBudget}`);

// ---- priority: under pressure, higher tiers survive, lower truncate/drop ----
check("under a tiny budget, pinned notes survive", bounded.includes("## Pinned notes"));
check("under a tiny budget, lowest tier (recent) is truncated/dropped",
  !bounded.includes("## Recent sessions") || bounded.split("\n").filter((l) => l.startsWith("- x")).length < 50);

// a budget big enough for notes+rules but not the full recent feed: recent truncates
const medium: InjectionTiers = {
  notes: ["- pinned: deploy via make ship"],
  rules: ["- always run npm test before pushing"],
  facts: [],
  recent: Array.from({ length: 20 }, (_, i) => ({ line: `- recent line number ${i} with some intent text here`, freshness: "fresh" as const })),
};
const med = buildInjection(medium, { budgetTokens: 80, scope: "personal" });
check("medium budget: notes + rules kept", med.includes("## Pinned notes") && med.includes("## Standing rules"));
const recentKept = med.split("\n").filter((l) => l.startsWith("- recent line")).length;
check("medium budget: recent feed truncated (fewer than 20)", recentKept < 20, `kept=${recentKept}`);
check("medium budget: still under budget", estimateTokens(med) <= 80, `est=${estimateTokens(med)}`);

// ---- a tier whose heading can't fit at all is skipped, not partially emitted ----
const headingOnly = buildInjection(
  { notes: ["- n"], rules: [], facts: [], recent: [] },
  { budgetTokens: estimateTokens(HEAD) + 3, scope: "personal" }, // room for heading, not a section
);
check("tier that can't afford its heading is skipped (no dangling heading)",
  headingOnly === "" || !headingOnly.includes("## Pinned notes"), headingOnly);

process.exit(failed ? 1 : 0);
