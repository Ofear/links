#!/usr/bin/env node
// links CLI entry — thin wrapper so `npx links <cmd>` / `npm link` work.
//
// `init` is handled HERE (distribution / Phase 5 scaffolding) so first-run setup
// has no dependency on the rest of the pipeline and is dry-run by default:
//   - detect which tools are installed (Claude Code / Codex / Cursor)
//   - write a personalized links.config.json (unless one exists)
//   - PRINT the MCP-server + SessionStart-hook registration it WOULD perform
// It never mutates ~/.claude or ~/.codex unless invoked with --apply (reserved;
// not yet implemented — printing is the contract until publish).
//
// Every other command is forwarded to src/cli.ts via tsx unchanged.
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");

const exists = (p) => access(p).then(() => true, () => false);
const expandHome = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Load config DEFAULTS from src/config.ts without compiling — run a tiny tsx probe. */
function loadDefaults() {
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

  // 1. Detect installed tools.
  const hasClaude = await exists(join(home, ".claude", "projects"));
  const hasCodex = await exists(join(home, ".codex", "sessions"));
  const hasCursor = await exists(join(home, ".cursor"));
  console.log(
    `detected: claude-code=${hasClaude} codex=${hasCodex} cursor=${hasCursor}` +
      ` (cursor: serving only, no ingest adapter yet)`,
  );
  if (!hasClaude && !hasCodex) {
    console.error("no supported session stores found (~/.claude/projects, ~/.codex/sessions) — nothing to index");
    process.exit(1);
  }

  // 2. Write a personalized links.config.json (only if absent — never clobber).
  const configPath = join(root, "links.config.json");
  if (await exists(configPath)) {
    console.log(`\nlinks.config.json already exists — keeping it (delete to re-generate).`);
  } else {
    // Single personal scope by default; the author's machine adds a wix scope.
    // Everything else falls through to src/config.ts DEFAULTS.
    const cfg = {
      $schema: "./schema/links.config.schema.json",
      $comment:
        "links config — scopes are cwd-prefix rules (first match wins, last is fallback). " +
        "Omitted fields fall back to src/config.ts defaults. Paths support leading ~.",
      scopes: [{ name: "personal", cwdPrefix: "~" }],
      excludeProjectDirs: [],
      storeDir: "~/.links/store",
      extractionEngine: "codex",
      gate: { minSizeKb: 10, maxJunkUserTurns: 2 },
    };
    await writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`\nwrote ${configPath} — review scopes/exclusions/storeDir, then re-run \`links init\`.`);
  }

  // 3. Resolve store dir + scope names from the (now-present) config.
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

  // 4. Print (dry-run) the registration we WOULD perform.
  const server = join(root, "src", "server.ts");
  const banner = apply
    ? "\n--apply is reserved and not implemented yet; printing the registration instead.\n"
    : "\nDRY RUN — run these yourself. links does not edit other tools' configs without you.\n";
  console.log(banner);
  console.log(`store dir: ${storeDir}`);

  for (const scope of scopes) {
    console.log(`\n# ── MCP server for scope "${scope}" ──`);
    if (hasClaude) {
      console.log(`claude mcp add --scope user links-${scope} -- ${tsx} ${server} ${scope}`);
    }
    if (hasCodex) {
      console.log(
        `# codex — add to ~/.codex/config.toml:\n` +
          `[mcp_servers.links-${scope}]\n` +
          `command = ${JSON.stringify(tsx)}\n` +
          `args = ${JSON.stringify([server, scope])}\n` +
          `# then per-tool: [mcp_servers.links-${scope}.tools.<search|get_card|read_session|expand_links|pin_note>] approval_mode = "approve"`,
      );
    }
    if (hasCursor) {
      console.log(
        `# cursor — add to ~/.cursor/mcp.json: ` +
          `"links-${scope}": { "command": ${JSON.stringify(tsx)}, "args": ${JSON.stringify([server, scope])} }`,
      );
    }
  }

  if (hasClaude) {
    console.log(`\n# ── Claude Code hooks (~/.claude/settings.json) ──`);
    console.log(`# SessionStart  → cd ${root} && npx tsx src/cli.ts inject "\${CLAUDE_PROJECT_DIR:-$PWD}"`);
    console.log(`# SessionEnd    → cd ${root} && npx tsx src/cli.ts refresh   (async)`);
  }

  console.log(`\n# ── Then build the index + cards ──`);
  console.log(`cd ${root} && npx tsx src/cli.ts ingest && npx tsx src/cli.ts extract --all && npx tsx src/cli.ts refresh`);
}

const cmd = process.argv[2];
if (cmd === "init") {
  await init(process.argv.slice(3));
} else {
  // Forward everything else to the TS CLI.
  const child = spawn(tsx, [join(root, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 1));
}
