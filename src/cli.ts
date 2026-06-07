/**
 * links CLI.
 *
 *   tsx src/cli.ts ingest   — scan Claude Code history → derived index per scope
 *
 * Writes store/<scope>/index.jsonl (one SessionMeta per line) — the tier-1
 * index. Cards (tier 2) are produced by the extractor (Phase 1b) and live
 * alongside as store/<scope>/cards/<id>.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanAllSessions } from "./adapters/index.js";
import { cardId, writeCard } from "./cards.js";
import { scopeForCwd, scopeNames, storeDir } from "./config.js";
import { extractCard } from "./extractor.js";
import type { SessionMeta } from "./types.js";

const STORE = storeDir();
const SCHEMA = join(import.meta.dirname, "..", "schema", "card.schema.json");

async function loadIndex(): Promise<SessionMeta[]> {
  const metas: SessionMeta[] = [];
  for (const scope of scopeNames()) {
    const raw = await readFile(join(STORE, scope, "index.jsonl"), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (line.trim()) metas.push(JSON.parse(line) as SessionMeta);
    }
  }
  return metas;
}

async function extract(idPrefixes: string[]): Promise<void> {
  const index = await loadIndex();
  let targets: SessionMeta[];
  if (idPrefixes[0] === "--all") {
    const force = idPrefixes.includes("--force");
    targets = [];
    const { EXTRACTOR_VERSION } = await import("./extractor.js");
    for (const m of index.filter((m) => m.gate.verdict === "card")) {
      const existing = await readFile(join(STORE, m.scope, "cards", `${cardId(m)}.json`), "utf8")
        .then((s) => JSON.parse(s) as { extractor_version?: number; source_size_kb?: number })
        .catch(() => null);
      // re-extract when: never carded, old extractor, or the session GREW since
      // carding (resumed sessions — a card frozen at 1MB misleads about a 5MB session)
      const grown = existing?.source_size_kb != null && m.sizeKb > existing.source_size_kb * 1.25 + 200;
      const current = existing && existing.extractor_version === EXTRACTOR_VERSION && !grown;
      if (force || !current) targets.push(m);
    }
    console.log(`extracting ${targets.length} of ${index.length} sessions (current-version+unchanged skipped${force ? "; --force" : ""})`);
  } else {
    targets = idPrefixes
      .map((p) => index.find((m) => m.id.startsWith(p)))
      .filter((m): m is SessionMeta => {
        if (!m) console.error(`✗ no session matching prefix in index (run ingest first)`);
        return !!m;
      });
  }
  let ok = 0, failed = 0;
  const runStart = Date.now();
  const total = targets.length;
  let done = 0;
  for (const meta of targets) {
    done++;
    if (meta.gate.verdict !== "card") {
      console.log(`[${done}/${total}] - ${meta.id.slice(0, 8)}: index-only, skipping`);
      continue;
    }
    // running ETA from mean time/session so far — progress you can act on
    const elapsed = (Date.now() - runStart) / 1000;
    const mean = done > 1 ? elapsed / (done - 1) : 0;
    const eta = mean ? ` · ~${Math.round((mean * (total - done + 1)) / 60)}m left` : "";
    console.log(`[${done}/${total}]${eta} ▸ ${meta.id.slice(0, 8)} (${meta.project}, ${meta.sizeKb}KB): ${meta.title.slice(0, 60)}`);
    const t0 = Date.now();
    try {
      const data = await extractCard(meta, SCHEMA, (s) => console.log(s));
      const path = await writeCard(STORE, meta, data);
      ok++;
      console.log(`  ✓ [${ok} done, ${failed} failed] ${((Date.now() - t0) / 1000).toFixed(0)}s, outcome: ${data.outcome}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ [${ok} done, ${failed} failed] FAILED: ${String(err).slice(0, 400)}`);
    }
  }
  console.log(`\ndone: ${ok} ok, ${failed} failed (${((Date.now() - runStart) / 1000 / 60).toFixed(1)}m total)`);
  if (failed) process.exitCode = 1;
}

async function ingest(): Promise<void> {
  const metas = await scanAllSessions();
  metas.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  const byScope = new Map<string, SessionMeta[]>();
  for (const m of metas) {
    (byScope.get(m.scope) ?? byScope.set(m.scope, []).get(m.scope)!).push(m);
  }

  for (const [scope, list] of byScope) {
    const dir = join(STORE, scope);
    await mkdir(join(dir, "cards"), { recursive: true });
    await writeFile(
      join(dir, "index.jsonl"),
      list.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );
  }

  // Report — loud about anything excluded or unparseable.
  const card = metas.filter((m) => m.gate.verdict === "card");
  const indexOnly = metas.filter((m) => m.gate.verdict === "index-only");
  const unparseable = indexOnly.filter(
    (m) => m.gate.verdict === "index-only" && m.gate.reason.startsWith("unparseable"),
  );
  console.log(`scanned:     ${metas.length} sessions`);
  for (const [scope, list] of byScope) {
    console.log(`  ${scope}: ${list.length} (${list.filter((m) => m.gate.verdict === "card").length} card-worthy)`);
  }
  console.log(`card-worthy: ${card.length}`);
  console.log(`index-only:  ${indexOnly.length}`);
  if (unparseable.length) {
    console.log(`⚠ UNPARSEABLE (${unparseable.length}) — investigate, do not ignore:`);
    for (const m of unparseable) {
      if (m.gate.verdict === "index-only") console.log(`  ${m.sourcePath}: ${m.gate.reason}`);
    }
  }
  const totalKb = card.reduce((s, m) => s + m.sizeKb, 0);
  console.log(`card corpus: ${(totalKb / 1024).toFixed(0)}MB ≈ ${(totalKb / 4000).toFixed(1)}M tokens`);
}

async function buildIndex(): Promise<void> {
  const { rebuildScope } = await import("./db.js");
  for (const scope of scopeNames()) {
    const r = await rebuildScope(join(STORE, scope)).catch((e) => {
      console.error(`✗ ${scope}: ${e}`);
      return undefined;
    });
    if (r) console.log(`${scope}: ${r.sessions} sessions indexed, ${r.cards} with cards`);
  }
}

/**
 * Tier-0 PUSH injection — called by a Claude Code SessionStart hook. Prints a
 * compact context block: recent sessions for the current project + pointer to
 * the MCP tools. Push beats pull: this is what makes the memory get used.
 */
async function inject(cwd: string): Promise<void> {
  const { recentForProject } = await import("./db.js");
  const { rulesForInjection, notesForInjection } = await import("./rules.js");
  const { basename } = await import("node:path");
  const scope = scopeForCwd(cwd);
  const scopeDir = join(STORE, scope);
  const project = basename(cwd);
  const rows = recentForProject(scopeDir, project, 8);
  const rules = await rulesForInjection(scopeDir, project);
  const notes = await notesForInjection(scopeDir, project);
  if (!rows.length && !rules.length && !notes.length) return; // nothing relevant — cost zero
  const parts: string[] = ["# links: memory for this project"];
  if (rules.length) {
    parts.push(
      `## Standing rules the user already told you (do NOT make them re-explain)\n${rules.join("\n")}`,
    );
  }
  if (notes.length) {
    parts.push(`## Pinned notes\n${notes.join("\n")}`);
  }
  if (rows.length) {
    const { getSessionRow } = await import("./db.js");
    const { validateCard } = await import("./validate.js");
    // Flag stale/broken recent cards right in the push so tier-0 never silently
    // asserts a fact whose code has since moved. Cheap: validateCard caches per
    // (repo, SHA) and these rows share one project ⇒ usually one git call.
    const lines = await Promise.all(
      rows.map(async (r) => {
        const base = `- ${r.card_id} · ${r.date} · ${r.outcome} · ${r.intent.slice(0, 100)}`;
        const sr = getSessionRow(scopeDir, r.card_id);
        if (!sr) return base;
        const m = JSON.parse((sr as unknown as { meta_json: string }).meta_json) as {
          filesTouched?: string[]; endedAt?: string; cwd?: string; gitCommit?: string; gitBranch?: string;
        };
        if (!m.filesTouched?.length) return base;
        const v = await validateCard({
          filesTouched: m.filesTouched, endedAt: m.endedAt, cwd: m.cwd,
          gitCommit: m.gitCommit, gitBranch: m.gitBranch,
        });
        return v.freshness === "stale" ? `${base}  [⚠ stale]`
          : v.freshness === "broken" ? `${base}  [⛔ code moved]`
          : base;
      }),
    );
    parts.push(
      `## Recent sessions (${rows.length})\nBefore re-investigating anything, check if it was already solved: ` +
        `use links-${scope} MCP (search → get_card → read_session with msg ranges). Pin durable facts with pin_note.\n` +
        lines.join("\n"),
    );
  }
  console.log(parts.join("\n\n"));
}

/** Compute graph edges and re-render all card .md files with their Links section. */
async function link(): Promise<void> {
  const { loadNodes, computeEdges } = await import("./linker.js");
  const { renderCard } = await import("./cards.js");
  const { planDedup } = await import("./dedup.js");
  for (const scope of scopeNames()) {
    const scopeDir = join(STORE, scope);
    const nodes = await loadNodes(scopeDir);
    const edges = computeEdges(nodes);
    let withCard = 0, totalEdges = 0, superseded = 0;
    for (const n of nodes) {
      if (!n.card) continue;
      const e = edges.get(n.cardId)!;
      totalEdges += e.relatesTo.length + e.supersedes.length;
      superseded += e.supersededBy.length ? 1 : 0;
      await writeFile(join(scopeDir, "cards", `${n.cardId}.md`), renderCard(n.meta, n.card, e));
      withCard++;
    }
    // persist the graph for the expand_links MCP tool
    await writeFile(
      join(scopeDir, "links.json"),
      JSON.stringify(Object.fromEntries([...edges].filter(([, e]) => e.relatesTo.length || e.supersedes.length || e.supersededBy.length)), null, 1),
    );
    // high-precision dedup: hide near-duplicate cards from default search (still
    // reachable by id / expand_links — never deleted). consolidation.json is the
    // auditable record the search layer reads.
    const plan = planDedup(nodes, edges);
    await writeFile(join(scopeDir, "consolidation.json"), JSON.stringify(plan, null, 1));
    console.log(
      `${scope}: ${withCard} cards re-rendered, ${totalEdges} edges, ${superseded} marked superseded, ` +
        `${plan.hidden.length} hidden as duplicates (${plan.decisions.length} consolidation decisions)`,
    );
  }
}

/** Full freshness pipeline — run after sessions end (hook/cron) or manually. */
async function refresh(): Promise<void> {
  await ingest();
  await extract(["--all"]); // skip-existing: only new sessions cost anything
  await link();
  await buildIndex();
  const { writeRulesFiles } = await import("./rules.js");
  for (const scope of scopeNames()) {
    await writeRulesFiles(join(STORE, scope));
  }
  console.log("refresh complete");
}

/**
 * First-run setup for a new machine: detect installed tools, write a
 * personalized links.config.json, scan the corpus, and PRINT the registration
 * commands (MCP servers + hooks) — we never silently edit another tool's
 * config on a machine we don't know.
 */
async function init(): Promise<void> {
  const { homedir } = await import("node:os");
  const { access } = await import("node:fs/promises");
  const { ROOT } = await import("./config.js");
  const exists = (p: string) => access(p).then(() => true, () => false);
  const home = homedir();

  const hasClaude = await exists(join(home, ".claude", "projects"));
  const hasCodex = await exists(join(home, ".codex", "sessions"));
  const hasCursor = await exists(join(home, ".cursor"));
  console.log(`detected: claude-code=${hasClaude} codex=${hasCodex} cursor=${hasCursor} (cursor: serving only, no adapter yet)`);
  if (!hasClaude && !hasCodex) {
    console.error("no supported session stores found — nothing to index");
    process.exit(1);
  }

  const configPath = join(ROOT, "links.config.json");
  if (await exists(configPath)) {
    console.log(`links.config.json already exists — keeping it (delete it to re-init)`);
  } else {
    await writeFile(
      configPath,
      JSON.stringify(
        {
          $comment: "links config — scopes are cwd-prefix rules, first match wins, last is fallback",
          scopes: [{ name: "personal", cwdPrefix: "~" }],
          excludeProjectDirs: [],
          gate: { minSizeKb: 10, maxJunkUserTurns: 2 },
        },
        null,
        2,
      ),
    );
    console.log(`wrote ${configPath} — edit scopes/exclusions, then re-run: links init`);
  }

  await ingest();

  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  const server = join(ROOT, "src", "server.ts");
  console.log(`\nNEXT STEPS (run these yourself — links does not edit other tools' configs):`);
  for (const scope of scopeNames()) {
    console.log(`\n# MCP server for scope "${scope}":`);
    if (hasClaude) console.log(`claude mcp add --scope user links-${scope} -- ${tsx} ${server} ${scope}`);
    if (hasCodex)
      console.log(
        `# codex: add to ~/.codex/config.toml:\n[mcp_servers.links-${scope}]\ncommand = "${tsx}"\nargs = ["${server}", "${scope}"]\n# plus per-tool: [mcp_servers.links-${scope}.tools.<search|get_card|read_session|expand_links|pin_note>] approval_mode = "approve"`,
      );
    if (hasCursor) console.log(`# cursor: add links-${scope} with command "${tsx}" args ["${server}", "${scope}"] to ~/.cursor/mcp.json`);
  }
  if (hasClaude) {
    console.log(`\n# Claude Code hooks (~/.claude/settings.json):`);
    console.log(`# SessionStart → cd ${ROOT} && npx tsx src/cli.ts inject "\${CLAUDE_PROJECT_DIR:-$PWD}"`);
    console.log(`# SessionEnd (async) → cd ${ROOT} && npx tsx src/cli.ts refresh`);
  }
  console.log(`\nthen: npx tsx src/cli.ts extract --all && npx tsx src/cli.ts refresh`);
}

const cmd = process.argv[2];
if (cmd === "ingest") {
  await ingest();
} else if (cmd === "init") {
  await init();
} else if (cmd === "index") {
  await buildIndex();
} else if (cmd === "link") {
  await link();
} else if (cmd === "refresh") {
  await refresh();
} else if (cmd === "rules") {
  const curate = process.argv.includes("--curate");
  const { writeRulesFiles } = await import("./rules.js");
  for (const scope of scopeNames()) {
    const r = await writeRulesFiles(join(STORE, scope), { curate });
    console.log(`${scope}: ${r.rules} rules across ${r.projects} project files${curate ? " (curated)" : ""}`);
  }
} else if (cmd === "inject") {
  await inject(process.argv[3] ?? process.cwd());
} else if (cmd === "extract") {
  const ids = process.argv.slice(3);
  if (!ids.length) {
    console.error("usage: tsx src/cli.ts extract <session-id-prefix>...");
    process.exit(1);
  }
  await extract(ids);
} else {
  console.error(
    "usage: tsx src/cli.ts init | ingest | index | link | rules [--curate] | refresh | inject [cwd] | extract <id>...|--all [--force]",
  );
  process.exit(1);
}
