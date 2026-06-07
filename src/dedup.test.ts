/** Run: npx tsx src/dedup.test.ts — exits non-zero on any failed expectation.
 *
 * Proves the conservative consolidation policy: clear near-duplicates COLLAPSE,
 * borderline / weak-evidence pairs only LINK (never silently merged), and the
 * false-merge guardrails (different work on shared files, succeeded-under-failed,
 * cross-project) hold. Precision over coverage — a wrong merge fails the suite.
 */
import { planDedup, jaccard, tokenize, type DedupDecision } from "./dedup.js";
import type { CardEdges, Node } from "./linker.js";
import type { CardData } from "./extractor.js";
import type { SessionMeta } from "./types.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ── synthetic node factory ──────────────────────────────────────────────────────
function node(opts: {
  id: string;
  project?: string;
  date: string;
  intent: string;
  title?: string;
  files: string[];
  outcome?: CardData["outcome"];
  card?: boolean; // false → index-only stub
}): Node {
  const meta = {
    id: opts.id,
    tool: "claude-code",
    scope: "personal",
    project: opts.project ?? "glow-up",
    title: opts.title ?? opts.intent,
  } as unknown as SessionMeta;
  const card =
    opts.card === false
      ? undefined
      : ({
          intent: opts.intent,
          outcome: opts.outcome ?? "succeeded",
          summary: [],
          decisions: [],
          issues: [],
          rules: [],
          entities: [],
        } as CardData);
  return {
    cardId: opts.id,
    meta,
    card,
    files: new Set(opts.files),
    entities: new Set(),
    date: opts.date,
  };
}

function find(ds: DedupDecision[], a: string, b: string): DedupDecision | undefined {
  return ds.find(
    (d) => (d.canonical === a && d.other === b) || (d.canonical === b && d.other === a),
  );
}

// ── unit-level sanity ─────────────────────────────────────────────────────────
check("jaccard identical sets = 1", jaccard(new Set(["a", "b"]), new Set(["a", "b"])) === 1);
check("jaccard disjoint = 0", jaccard(new Set(["a"]), new Set(["b"])) === 0);
check("jaccard of two empties = 0 (no evidence, not identical)", jaccard(new Set(), new Set()) === 0);
check("tokenize drops stopwords/short", JSON.stringify(tokenize("fix the SMS auth bug")) === JSON.stringify(["sms", "auth"]));

// ── CASE 1: recurring nightly run — must COLLAPSE ───────────────────────────────
{
  const files = ["~/proj/scan.ts", "~/proj/report.ts", "~/proj/index.ts"];
  const nodes = [
    node({ id: "cc-2026-06-01-aaaa", date: "2026-06-01", intent: "run nightly scan and generate health report", files }),
    node({ id: "cc-2026-06-02-bbbb", date: "2026-06-02", intent: "run nightly scan and generate health report", files }),
    node({ id: "cc-2026-06-03-cccc", date: "2026-06-03", intent: "run nightly scan and generate health report", files }),
  ];
  const plan = planDedup(nodes);
  // newest (06-03) is canonical; the two older ones collapse under newer canonicals
  check("CASE1: identical recurring runs produce collapse decisions", plan.decisions.some((d) => d.action === "collapse"));
  check("CASE1: older runs are hidden", plan.hidden.length >= 1, `hidden=${plan.hidden}`);
  check("CASE1: newest run is NOT hidden", !plan.hidden.includes("cc-2026-06-03-cccc"));
  check("CASE1: idempotent (re-run identical plan)", JSON.stringify(planDedup(nodes)) === JSON.stringify(plan));
}

// ── CASE 2: same files, DIFFERENT work — must NOT collapse (false-merge guard) ──
{
  const files = ["~/proj/config.ts", "~/proj/app.ts"]; // a shared config both touch
  const nodes = [
    node({ id: "cc-2026-06-01-d111", date: "2026-06-01", intent: "add SMS retry logic to the notification sender", files }),
    node({ id: "cc-2026-06-02-d222", date: "2026-06-02", intent: "migrate the database schema to add audit columns", files }),
  ];
  const plan = planDedup(nodes);
  const d = find(plan.decisions, "cc-2026-06-01-d111", "cc-2026-06-02-d222");
  check("CASE2: shared files + different intent → NOT collapsed", !d || d.action !== "collapse", `action=${d?.action}`);
  check("CASE2: nothing hidden", plan.hidden.length === 0, `hidden=${plan.hidden}`);
}

// ── CASE 3: borderline — same intent but only PARTIAL file overlap → LINK ───────
// Intent is identical (intentJaccard = 1) BUT files overlap only 2/4 = 0.5
// (above RELATED 0.34, below COLLAPSE 0.9). Same-sounding task, different actual
// edits → not confident enough to bury one card. Must LINK, never collapse.
{
  const intent = "investigate and fix the checkout payment flow latency";
  const nodes = [
    node({ id: "cc-2026-06-01-e111", date: "2026-06-01", intent, files: ["~/proj/checkout.ts", "~/proj/checkout.test.ts", "~/proj/helpers.ts"] }),
    node({ id: "cc-2026-06-02-e222", date: "2026-06-02", intent, files: ["~/proj/checkout.ts", "~/proj/checkout.test.ts", "~/proj/webhook.ts"] }),
  ];
  const plan = planDedup(nodes);
  const d = find(plan.decisions, "cc-2026-06-01-e111", "cc-2026-06-02-e222");
  check("CASE3: borderline pair gets a decision (related)", !!d, JSON.stringify(plan.decisions));
  check("CASE3: borderline pair is LINK, not collapse", d?.action === "link", `action=${d?.action}`);
  check("CASE3: borderline pair hides nothing", plan.hidden.length === 0);
}

// ── CASE 4: succeeded older vs abandoned newer twin — guard refuses to bury result ─
{
  const files = ["~/proj/fix.ts", "~/proj/util.ts", "~/proj/main.ts"];
  const nodes = [
    node({ id: "cc-2026-06-01-f111", date: "2026-06-01", intent: "fix the OAuth token refresh race condition", files, outcome: "succeeded" }),
    node({ id: "cc-2026-06-05-f222", date: "2026-06-05", intent: "fix the OAuth token refresh race condition", files, outcome: "abandoned" }),
  ];
  const plan = planDedup(nodes);
  const d = find(plan.decisions, "cc-2026-06-01-f111", "cc-2026-06-05-f222");
  check("CASE4: would-be collapse downgraded to LINK (don't bury a success)", d?.action === "link", `action=${d?.action}`);
  check("CASE4: succeeded card not hidden", !plan.hidden.includes("cc-2026-06-01-f111"));
}

// ── CASE 5: cross-project identical text — never consolidated ───────────────────
{
  const files = ["~/proj/build.ts"];
  const nodes = [
    node({ id: "cc-2026-06-01-g111", project: "alpha", date: "2026-06-01", intent: "set up the build pipeline configuration", files }),
    node({ id: "cc-2026-06-02-g222", project: "beta", date: "2026-06-02", intent: "set up the build pipeline configuration", files }),
  ];
  const plan = planDedup(nodes);
  check("CASE5: cross-project pair produces NO decision", plan.decisions.length === 0, JSON.stringify(plan.decisions));
}

// ── CASE 6: index-only stub (no card) — skipped, never merged ───────────────────
{
  const files = ["~/proj/x.ts", "~/proj/y.ts", "~/proj/z.ts"];
  const nodes = [
    node({ id: "cc-2026-06-01-h111", date: "2026-06-01", intent: "refactor the export module structure", files }),
    node({ id: "cc-2026-06-02-h222", date: "2026-06-02", intent: "refactor the export module structure", files, card: false }),
  ];
  const plan = planDedup(nodes);
  check("CASE6: stub-vs-card produces no decision", plan.decisions.length === 0);
}

// ── CASE 7: supersede via linker continuity edge ────────────────────────────────
{
  const files = ["~/proj/feat.ts", "~/proj/feat.test.ts"]; // strong file overlap but distinct intent → not collapse
  const nodes = [
    node({ id: "cc-2026-06-01-i111", date: "2026-06-01", intent: "start building the new dashboard widget layout", files }),
    node({ id: "cc-2026-06-02-i222", date: "2026-06-02", intent: "continue dashboard widget, wire up the data fetching", files }),
  ];
  const edges = new Map<string, CardEdges>([
    ["cc-2026-06-01-i111", { relatesTo: [], supersedes: [], supersededBy: ["cc-2026-06-02-i222"] }],
    ["cc-2026-06-02-i222", { relatesTo: [], supersedes: ["cc-2026-06-01-i111"], supersededBy: [] }],
  ]);
  const plan = planDedup(nodes, edges);
  const d = find(plan.decisions, "cc-2026-06-01-i111", "cc-2026-06-02-i222");
  check("CASE7: linker supersedes edge → supersede action", d?.action === "supersede", `action=${d?.action}`);
  check("CASE7: supersede does NOT hide either card", plan.hidden.length === 0);
}

// ── CASE 8: no transitive collapse — a hidden card can't be a canonical that hides others
{
  const files = ["~/p/a.ts", "~/p/b.ts", "~/p/c.ts"];
  const intent = "regenerate the localization message bundles";
  const nodes = [
    node({ id: "cc-2026-06-01-j100", date: "2026-06-01", intent, files }),
    node({ id: "cc-2026-06-02-j200", date: "2026-06-02", intent, files }),
    node({ id: "cc-2026-06-03-j300", date: "2026-06-03", intent, files }),
  ];
  const plan = planDedup(nodes);
  // every hidden card must never appear as canonical of a collapse decision
  const collapseCanonicals = new Set(plan.decisions.filter((d) => d.action === "collapse").map((d) => d.canonical));
  const noChain = plan.hidden.every((h) => !collapseCanonicals.has(h));
  check("CASE8: no collapse chains (hidden card is never a collapse canonical)", noChain, `hidden=${plan.hidden} canonicals=${[...collapseCanonicals]}`);
}

process.exit(failed ? 1 : 0);
