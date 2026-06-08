#!/usr/bin/env node
// links CLI entry — the installed binary.
//
// Runs the COMPILED tool from dist/ (no tsx, no source tree needed). Falls back
// to tsx + src/ when dist/ is absent (local dev before `npm run build`).
//
// `init` is handled HERE (distribution / first-run setup) so it has no dependency
// on the rest of the pipeline: it detects installed tools, writes links.config.json
// (default store ~/.links/store), and prints the MCP + hook registration using the
// installed `links` commands. `serve <scope>` launches the MCP server for a scope.
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distCli = join(root, "dist", "cli.js");
const distServer = join(root, "dist", "server.js");
const distConfig = join(root, "dist", "config.js");
const tsx = join(root, "node_modules", ".bin", "tsx");
const useDist = existsSync(distCli);

const exists = (p) => access(p).then(() => true, () => false);
const expandHome = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Is a command on PATH and runnable? (used to pick an extraction engine). */
const hasBin = (name) =>
  new Promise((r) => {
    const c = spawn(name, ["--version"], { stdio: "ignore" });
    c.on("error", () => r(false));
    c.on("close", (code) => r(code === 0));
  });

/** Run a tool entrypoint: compiled JS via node, or src TS via tsx in dev. */
function run(distPath, srcRel, args) {
  const [bin, pre] = useDist ? [process.execPath, [distPath]] : [tsx, [join(root, "src", srcRel)]];
  const child = spawn(bin, [...pre, ...args], { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 1));
  child.on("error", (e) => {
    console.error(`links: failed to start (${e.message}). Try \`npm run build\`.`);
    process.exit(1);
  });
}

/** Load config defaults — from compiled dist, or a tsx probe in dev. */
async function loadDefaults() {
  if (useDist && existsSync(distConfig)) {
    try {
      const mod = await import(pathToFileURL(distConfig).href);
      return mod.defaults?.() ?? null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const probe =
      "import {defaults} from " +
      JSON.stringify(join(root, "src", "config.ts")) +
      "; process.stdout.write(JSON.stringify(defaults()));";
    const child = spawn(tsx, ["-e", probe], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

/** Read JSON (or {} if absent), let mutate() change it, back up once, write back. */
async function editJson(path, mutate) {
  let obj = {};
  let existed = false;
  try {
    obj = JSON.parse(await readFile(path, "utf8"));
    existed = true;
  } catch {
    /* new file */
  }
  const changed = mutate(obj);
  if (!changed) return false;
  if (existed && !(await exists(path + ".bak"))) {
    await writeFile(path + ".bak", JSON.stringify(obj, null, 2)); // one-time safety backup
  }
  await writeFile(path, JSON.stringify(obj, null, 2) + "\n");
  return true;
}

/** Actually wire Claude Code: add MCP servers (~/.claude.json) + hooks (settings.json). */
async function applyClaude(home, scopes) {
  const claudeJson = join(home, ".claude.json");
  const settings = join(home, ".claude", "settings.json");

  const mcpChanged = await editJson(claudeJson, (j) => {
    j.mcpServers ??= {};
    let added = 0;
    for (const scope of scopes) {
      const name = `links-${scope}`;
      if (!j.mcpServers[name]) {
        j.mcpServers[name] = { command: "links", args: ["serve", scope] };
        added++;
      }
    }
    if (added) console.log(`  ✓ added ${added} MCP server(s) to ~/.claude.json`);
    return added > 0;
  });
  if (!mcpChanged) console.log(`  · MCP servers already present in ~/.claude.json`);

  const hooksChanged = await editJson(settings, (j) => {
    j.hooks ??= {};
    let changed = false;
    const has = (event, needle) =>
      (j.hooks[event] ?? []).some((g) =>
        (g.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(needle)),
      );
    if (!has("SessionStart", "links inject") && !has("SessionStart", "cli.ts inject")) {
      (j.hooks.SessionStart ??= []).push({
        hooks: [{ type: "command", command: 'links inject "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true', statusMessage: "links: recalling past sessions" }],
      });
      changed = true;
    }
    if (!has("SessionEnd", "links refresh") && !has("SessionEnd", "cli.ts refresh")) {
      (j.hooks.SessionEnd ??= []).push({
        hooks: [{ type: "command", command: "links refresh >/dev/null 2>&1 || true", statusMessage: "links: memorizing this session" }],
      });
      changed = true;
    }
    if (changed) console.log(`  ✓ added SessionStart/SessionEnd hooks to settings.json`);
    return changed;
  });
  if (!hooksChanged) console.log(`  · hooks already present in settings.json`);
  console.log(`  (backups written as *.bak on first change; restart Claude Code to load)`);
}

async function init(argv) {
  const apply = argv.includes("--apply");
  const home = homedir();

  const hasClaude = await exists(join(home, ".claude", "projects"));
  const hasCodex = await exists(join(home, ".codex", "sessions"));
  const hasCursor = await exists(join(home, ".cursor"));
  console.log(`detected: claude-code=${hasClaude} codex=${hasCodex} cursor=${hasCursor}`);
  if (!hasClaude && !hasCodex) {
    console.error("no supported session stores found (~/.claude/projects, ~/.codex/sessions) — nothing to index");
    process.exit(1);
  }

  // Pick an extraction engine by what's actually installed: codex (preferred,
  // --ephemeral-clean) → claude headless → codex default (errors later if neither).
  const hasCodexBin = await hasBin("codex");
  const hasClaudeBin = await hasBin("claude");
  const engine = hasCodexBin ? "codex" : hasClaudeBin ? "claude" : "codex";
  console.log(`extraction engine: ${engine}` + (hasCodexBin || hasClaudeBin ? "" : "  ⚠ neither codex nor claude CLI found — install one to extract cards"));

  // Write config to ~/.links/config.json — survives package updates, found regardless
  // of CWD (only if absent — never clobber). Override location with LINKS_CONFIG.
  const configPath = process.env.LINKS_CONFIG || join(home, ".links", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  if (await exists(configPath)) {
    console.log(`\n${configPath} already exists — keeping it (delete to re-generate).`);
  } else {
    const cfg = {
      $schema: join(root, "schema", "links.config.schema.json"),
      $comment:
        "links config — scopes are cwd-prefix rules (first match wins, last is fallback). " +
        "Omitted fields fall back to built-in defaults. Paths support leading ~.",
      scopes: [{ name: "personal", cwdPrefix: "~" }],
      excludeProjectDirs: [],
      storeDir: "~/.links/store",
      extractionEngine: engine,
      gate: { minSizeKb: 10, maxJunkUserTurns: 2 },
    };
    await writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`\nwrote ${configPath} — review scopes/storeDir, then re-run \`links init\`.`);
  }

  const def = (await loadDefaults()) ?? {};
  let scopes = ["personal"];
  let storeDir = expandHome(def.storeDir ?? "~/.links/store");
  try {
    const user = JSON.parse(await readFile(configPath, "utf8"));
    if (Array.isArray(user.scopes) && user.scopes.length) scopes = user.scopes.map((s) => s.name);
    if (user.storeDir) storeDir = expandHome(user.storeDir);
  } catch {
    /* defaults stand */
  }

  console.log(`store dir: ${storeDir}`);

  if (apply && hasClaude) {
    console.log(`\nAPPLYING Claude Code wiring (idempotent; *.bak backups on first change):`);
    await applyClaude(home, scopes);
  } else if (hasClaude) {
    console.log(`\nDRY RUN — re-run \`links init --apply\` to wire Claude Code automatically, or do it yourself:`);
    for (const scope of scopes) console.log(`claude mcp add --scope user links-${scope} -- links serve ${scope}`);
    console.log(`# hooks (~/.claude/settings.json): SessionStart → links inject "\${CLAUDE_PROJECT_DIR:-$PWD}" ; SessionEnd → links refresh`);
  }

  // codex/cursor are always printed — --apply automates Claude Code only for now.
  for (const scope of scopes) {
    if (hasCodex)
      console.log(`\n# codex — add to ~/.codex/config.toml:\n[mcp_servers.links-${scope}]\ncommand = "links"\nargs = ["serve", "${scope}"]`);
    if (hasCursor)
      console.log(`# cursor — add to ~/.cursor/mcp.json: "links-${scope}": { "command": "links", "args": ["serve", "${scope}"] }`);
  }

  console.log(`\n# ── Then build the index + cards ──`);
  console.log(`links ingest && links extract --all && links refresh`);
}

const cmd = process.argv[2];
if (cmd === "init") {
  await init(process.argv.slice(3));
} else if (cmd === "serve") {
  run(distServer, "server.ts", process.argv.slice(3));
} else {
  run(distCli, "cli.ts", process.argv.slice(2));
}
