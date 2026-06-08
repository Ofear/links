/** Run: npx tsx src/config.test.ts — exits non-zero on any failure. */
import {
  config,
  defaults,
  expandHome,
  resetConfigCache,
  scopeForCwd,
  scopeNames,
  setConfigForTest,
  storeDir,
} from "./config.js";
import { homedir } from "node:os";
import { join } from "node:path";

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}${detail ? ` → ${detail}` : ""}`);
    failed++;
  }
}

// ---- defaults are GENERIC (no machine-specific values shipped) ----
const d = defaults();
check("default scopes: single generic personal", d.scopes.length === 1 && d.scopes[0]?.name === "personal");
check("default excludes are empty (machine-specific excludes live in ~/.links/config.json)", d.excludeProjectDirs.length === 0);
check("default extraction engine is codex", d.extractionEngine === "codex");
check("default codexFallback targets the cursor extension", d.codexFallback.extensionPrefix === "openai.chatgpt-");
check("default gate.minSizeKb=10", d.gate.minSizeKb === 10);

// ---- expandHome ----
check("expandHome resolves ~", expandHome("~/x") === join(homedir(), "x"));
check("expandHome leaves absolute paths", expandHome("/etc/x") === "/etc/x");

// ---- pure defaults (no file injected) ----
setConfigForTest({});
check("storeDir default is ~/.links/store (user home, not package dir)", storeDir() === join(homedir(), ".links/store"));
check("scopeNames from defaults", JSON.stringify(scopeNames()) === JSON.stringify(["personal"]));
check("scopeForCwd any path → personal (only scope)", scopeForCwd(join(homedir(), "Projects/Wix/foo")) === "personal");
check("scopeForCwd empty cwd → personal", scopeForCwd("") === "personal");

// ---- override merges (deep-merge nested objects, replace top-level arrays) ----
setConfigForTest({
  scopes: [
    { name: "work", cwdPrefix: "~/code/work" },
    { name: "home", cwdPrefix: "~" },
  ],
  storeDir: "~/.links/store",
  sources: { codexSessions: "~/custom/codex" }, // partial nested override
  gate: { minSizeKb: 99 }, // partial nested override
});
const c = config();
check("override replaces scopes array", JSON.stringify(scopeNames()) === JSON.stringify(["work", "home"]));
check("override scopeForCwd uses new rules", scopeForCwd(join(homedir(), "code/work/x")) === "work");
check("override scopeForCwd fallback uses new last rule", scopeForCwd("/var/tmp") === "home");
check("override storeDir is honored + home-expanded", storeDir() === join(homedir(), ".links/store"));
check("partial sources override keeps the un-overridden default", c.sources.claudeProjects === d.sources.claudeProjects);
check("partial sources override applies the new value", c.sources.codexSessions === "~/custom/codex");
check("partial gate override keeps junkTitleRe default", c.gate.junkTitleRe === d.gate.junkTitleRe && c.gate.minSizeKb === 99);

// ---- cache reset ----
resetConfigCache();
const fresh = config(); // re-reads links.config.json (or falls back to defaults)
check("config() returns a value after cache reset", !!fresh && Array.isArray(fresh.scopes));

process.exit(failed ? 1 : 0);
