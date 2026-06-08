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
import { access, readFile, writeFile } from "node:fs/promises";
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

  // Write links.config.json next to the install (only if absent — never clobber).
  const configPath = join(root, "links.config.json");
  if (await exists(configPath)) {
    console.log(`\nlinks.config.json already exists — keeping it (delete to re-generate).`);
  } else {
    const cfg = {
      $schema: "./schema/links.config.schema.json",
      $comment:
        "links config — scopes are cwd-prefix rules (first match wins, last is fallback). " +
        "Omitted fields fall back to built-in defaults. Paths support leading ~.",
      scopes: [{ name: "personal", cwdPrefix: "~" }],
      excludeProjectDirs: [],
      storeDir: "~/.links/store",
      extractionEngine: "codex",
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

  console.log(
    apply
      ? "\n--apply is reserved and not implemented yet; printing the registration instead.\n"
      : "\nDRY RUN — run these yourself. links does not edit other tools' configs without you.\n",
  );
  console.log(`store dir: ${storeDir}`);

  for (const scope of scopes) {
    console.log(`\n# ── MCP server for scope "${scope}" ──`);
    if (hasClaude) console.log(`claude mcp add --scope user links-${scope} -- links serve ${scope}`);
    if (hasCodex)
      console.log(
        `# codex — add to ~/.codex/config.toml:\n` +
          `[mcp_servers.links-${scope}]\ncommand = "links"\nargs = ["serve", "${scope}"]`,
      );
    if (hasCursor)
      console.log(`# cursor — add to ~/.cursor/mcp.json: "links-${scope}": { "command": "links", "args": ["serve", "${scope}"] }`);
  }

  if (hasClaude) {
    console.log(`\n# ── Claude Code hooks (~/.claude/settings.json) ──`);
    console.log(`# SessionStart → links inject "\${CLAUDE_PROJECT_DIR:-$PWD}"`);
    console.log(`# SessionEnd   → links refresh   (run async)`);
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
