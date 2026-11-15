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
  const { rulesForInjection, notesForInjection, factsForInjection } = await import("./rules.js");
  const { basename } = await import("node:path");
  const scope = scopeForCwd(cwd);
  const scopeDir = join(STORE, scope);
  const project = basename(cwd);
  const rows = recentForProject(scopeDir, project, 8);
  const rules = await rulesForInjection(scopeDir, project);
  const facts = await factsForInjection(scopeDir, project);
  const notes = await notesForInjection(scopeDir, project);
  if (!rows.length && !rules.length && !facts.length && !notes.length) return; // nothing relevant — cost zero

  // Validate each recent row against current code so the assembler can drop
  // broken rows / flag stale ones. Cheap: validateCard caches per (repo, SHA)
  // and these rows share one project ⇒ usually one git call.
  const { getSessionRow } = await import("./db.js");
  const { validateCard } = await import("./validate.js");
  const recent = await Promise.all(
    rows.map(async (r) => {
      const line = `- ${r.card_id} · ${r.date} · ${r.outcome} · ${r.intent.slice(0, 100)}`;
      const sr = getSessionRow(scopeDir, r.card_id);
      if (!sr) return { line, freshness: "unknown" as const };
      const m = JSON.parse((sr as unknown as { meta_json: string }).meta_json) as {
        filesTouched?: string[]; endedAt?: string; cwd?: string; gitCommit?: string; gitBranch?: string;
      };
      if (!m.filesTouched?.length) return { line, freshness: "unknown" as const };
      const v = await validateCard({
        filesTouched: m.filesTouched, endedAt: m.endedAt, cwd: m.cwd,
        gitCommit: m.gitCommit, gitBranch: m.gitBranch,
      });
      return { line, freshness: v.freshness };
    }),
  );

  const { buildInjection } = await import("./inject.js");
  const { config } = await import("./config.js");
  const block = buildInjection(
    { notes, rules, facts, recent },
    { budgetTokens: config().injectBudgetTokens, scope },
  );
  if (block) console.log(block);
}

/** Read piped stdin (the hook payload JSON) to completion; "" if none/TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Per-turn PULL→PUSH bridge — called by a Claude Code UserPromptSubmit hook.
 * Reads the user's prompt from the hook payload, runs hybrid search, and pushes
 * the top relevant card(s) into context so the agent sees prior work WITHOUT
 * having to think to search. Three guards keep it native-but-light (not a
 * claude-mem firehose):
 *   1. ABSOLUTE relevance gate — query↔card cosine ≥ RECALL_MIN_SIM. Fused score
 *      is relative (always ~high), so we gate on raw semantic sim instead.
 *   2. Per-session dedup — never re-surface a card already injected this session.
 *   3. Cap 2 + skip trivial prompts. Nothing clears the bar ⇒ zero output.
 */
// MiniLM cosine: real topical hits land ~0.4+, unrelated noise <0.2 — 0.35 sits
// in the clear gap (measured: relevant 0.44 vs next-best 0.17 on this corpus).
const RECALL_MIN_SIM = 0.35;
async function recall(): Promise<void> {
  const input = await readStdin();
  let payload: { prompt?: string; cwd?: string; session_id?: string } = {};
  try {
    payload = JSON.parse(input);
  } catch {
    /* not invoked as a hook — fall back to argv */
  }
  const prompt = (payload.prompt ?? process.argv[3] ?? "").trim();
  if (prompt.length < 12) return; // too short to be a real recall query
  const cwd = payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const sessionId = payload.session_id ?? "nosession";
  const scope = scopeForCwd(cwd);
  const scopeDir = join(STORE, scope);

  const { hybridSearch, getSessionRow } = await import("./db.js");
  let hits;
  try {
    hits = await hybridSearch(scopeDir, prompt, 5);
  } catch {
    return; // search/embed unavailable → silent, never block the prompt
  }
  const relevant = hits.filter((h) => h.has_card && (h.semanticSim ?? 0) >= RECALL_MIN_SIM);
  if (!relevant.length) return; // nothing clears the absolute bar → cost zero

  // per-session dedup: don't re-surface a card already pushed this session
  const { homedir } = await import("node:os");
  const cacheDir = join(homedir(), ".links", "cache");
  await mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `recall-${sessionId.replace(/[^\w.-]/g, "_")}.json`);
  const seen = JSON.parse(await readFile(cachePath, "utf8").catch(() => "[]")) as string[];
  const fresh = relevant.filter((h) => !seen.includes(h.card_id)).slice(0, 2);
  if (!fresh.length) return;

  // flag stale/broken so a per-turn nudge never silently asserts moved code
  const { validateCard } = await import("./validate.js");
  const lines = await Promise.all(
    fresh.map(async (h) => {
      const base = `- ${h.card_id} · ${h.date} · ${h.intent.slice(0, 100)} — ${h.why}`;
      const sr = getSessionRow(scopeDir, h.card_id);
      if (!sr) return base;
      const m = JSON.parse((sr as unknown as { meta_json: string }).meta_json) as {
        filesTouched?: string[]; endedAt?: string; cwd?: string; gitCommit?: string; gitBranch?: string;
      };
      if (!m.filesTouched?.length) return base;
      const v = await validateCard({
        filesTouched: m.filesTouched, endedAt: m.endedAt, cwd: m.cwd, gitCommit: m.gitCommit, gitBranch: m.gitBranch,
      });
      return v.freshness === "stale" ? `${base}  [⚠ stale]`
        : v.freshness === "broken" ? `${base}  [⛔ code moved]`
        : base;
    }),
  );

  await writeFile(cachePath, JSON.stringify([...seen, ...fresh.map((h) => h.card_id)]));
  console.log(
    `# links: possibly relevant past work — get_card via links-${scope} MCP for detail\n${lines.join("\n")}`,
  );
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
  const { writeRulesFiles, writeFactsFiles } = await import("./rules.js");
  for (const scope of scopeNames()) {
    await writeRulesFiles(join(STORE, scope));
    await writeFactsFiles(join(STORE, scope));
  }
  console.log("refresh complete");
}

/**
 * Migrate a store written under an OLD cardId scheme (cc-DATE-{hash8}) to the
 * current full-UUID scheme (cc-DATE-{full-id}; see cards.ts — full ids prevent
 * the prefix collisions that short hashes caused for Codex sessions). Card
 * CONTENTS are unchanged, so this RENAMES files in place — no re-extraction —
 * then rebuilds derived data (graph + index + rules) so the store is immediately
 * consistent. Idempotent: an already-migrated store renames nothing.
 *
 * Match is from the file side by UUID prefix, scoped, and collision-safe: a
 * short tail matching 0 or >1 index ids is reported and skipped, never guessed.
 */
async function migrate(): Promise<void> {
  const { readdir, rename } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  let totalRenamed = 0;
  for (const scope of scopeNames()) {
    const scopeDir = join(STORE, scope);
    const cardsDir = join(scopeDir, "cards");
    const raw = await readFile(join(scopeDir, "index.jsonl"), "utf8").catch(() => "");
    const metas = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SessionMeta);
    const files = await readdir(cardsDir).catch(() => [] as string[]);
    let renamed = 0, ambiguous = 0, orphan = 0;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      // strip "<tool>-YYYY-MM-DD-" → the trailing id token; a full uuid is 36 chars
      const tail = f.replace(/^[a-z]{2}-\d{4}-\d{2}-\d{2}-/, "").replace(/\.json$/, "");
      if (tail.length > 8) continue; // already full-uuid (or non-standard) — leave it
      const cands = metas.filter((m) => m.id.startsWith(tail));
      if (cands.length !== 1) {
        cands.length ? ambiguous++ : orphan++;
        continue;
      }
      const oldBase = f.replace(/\.json$/, "");
      const newBase = cardId(cands[0]!);
      if (newBase === oldBase) continue;
      for (const ext of [".json", ".md"]) {
        const o = join(cardsDir, oldBase + ext);
        if (existsSync(o)) {
          await rename(o, join(cardsDir, newBase + ext));
          renamed++;
        }
      }
    }
    totalRenamed += renamed;
    const extra = [ambiguous && `${ambiguous} ambiguous`, orphan && `${orphan} orphan (no index match)`]
      .filter(Boolean).join(", ");
    console.log(`${scope}: ${renamed} files renamed${extra ? ` — skipped ${extra}` : ""}`);
  }
  if (totalRenamed === 0) {
    console.log("store already on the current cardId scheme — nothing to migrate");
    return;
  }
  console.log("rebuilding graph + index + rules…");
  await link();
  await buildIndex();
  const { writeRulesFiles } = await import("./rules.js");
  for (const scope of scopeNames()) await writeRulesFiles(join(STORE, scope));
  console.log(`migrate complete: ${totalRenamed} files renamed`);
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
} else if (cmd === "migrate") {
  await migrate();
} else if (cmd === "rules") {
  const curate = process.argv.includes("--curate");
  const { writeRulesFiles } = await import("./rules.js");
  for (const scope of scopeNames()) {
    const r = await writeRulesFiles(join(STORE, scope), { curate });
    console.log(`${scope}: ${r.rules} rules across ${r.projects} project files${curate ? " (curated)" : ""}`);
  }
} else if (cmd === "inject") {
  await inject(process.argv[3] ?? process.cwd());
} else if (cmd === "recall") {
  await recall();
} else if (cmd === "extract") {
  const ids = process.argv.slice(3);
  if (!ids.length) {
    console.error("usage: tsx src/cli.ts extract <session-id-prefix>...");
    process.exit(1);
  }
  await extract(ids);
} else {
  console.error(
    "usage: tsx src/cli.ts init | ingest | index | link | rules [--curate] | refresh | migrate | inject [cwd] | recall (stdin hook payload) | extract <id>...|--all [--force]",
  );
  process.exit(1);
}
