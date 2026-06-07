/**
 * Configuration — Phase 5 (distribution).
 *
 * Every machine-specific value lives here as a DEFAULT, overridable by
 * links.config.json in the project root. The defaults reproduce this
 * machine's behavior byte-for-byte; `links init` writes a personalized
 * config for a new machine.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ScopeRule {
  /** Scope name — becomes store/<name>/ and the MCP server suffix. */
  name: string;
  /** cwd prefix (supports leading ~). First matching rule wins. */
  cwdPrefix: string;
}

export interface LinksConfig {
  /** Ordered scope rules; the LAST entry is the fallback scope. */
  scopes: ScopeRule[];
  /** Claude Code project dirs that are synthetic corpora — never ingested. */
  excludeProjectDirs: string[];
  /** Extraction engine binary override (else auto-discovery). */
  codexBin?: string;
  gate: {
    minSizeKb: number;
    /** Single-shot junk asks — index-only, no card. */
    junkTitleRe: string;
    maxJunkUserTurns: number;
  };
}

const DEFAULTS: LinksConfig = {
  scopes: [
    { name: "wix", cwdPrefix: "~/Projects/Wix" },
    { name: "personal", cwdPrefix: "~" }, // fallback
  ],
  excludeProjectDirs: ["-home-ofirh--claude-mem-observer-sessions"],
  gate: {
    minSizeKb: 10,
    junkTitleRe: "^(hi|hello|hey|ls|pwd|cd(\\s+\\S+)?|test|ok|yes|continue)[.!?]?$",
    maxJunkUserTurns: 2,
  },
};

export const ROOT = join(import.meta.dirname, "..");

let cached: LinksConfig | undefined;
export function config(): LinksConfig {
  if (cached) return cached;
  try {
    const user = JSON.parse(readFileSync(join(ROOT, "links.config.json"), "utf8")) as Partial<LinksConfig>;
    cached = { ...DEFAULTS, ...user, gate: { ...DEFAULTS.gate, ...user.gate } };
  } catch {
    cached = DEFAULTS;
  }
  return cached;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** First matching scope rule wins; last rule is the fallback. */
export function scopeForCwd(cwd: string): string {
  const rules = config().scopes;
  for (const r of rules) {
    if (cwd.startsWith(expandHome(r.cwdPrefix))) return r.name;
  }
  return rules[rules.length - 1]?.name ?? "personal";
}

export function scopeNames(): string[] {
  return config().scopes.map((s) => s.name);
}
