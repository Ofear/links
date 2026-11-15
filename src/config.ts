/**
 * Configuration — Phase 5 (distribution).
 *
 * Every machine-specific value lives here as a DEFAULT, overridable by
 * links.config.json in the project root. The defaults reproduce THIS machine's
 * behavior byte-for-byte; `links init` (bin/links.js) writes a personalized
 * config for a new machine. The rule (DESIGN.md Phase 5): machine-specific
 * values are config DEFAULTS, never constants.
 *
 * Schema: schema/links.config.schema.json (kept in sync with LinksConfig).
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

/**
 * Which engine turns a transcript into a card.
 *   codex   — `codex exec` headless (current mechanism; the codexJson seam)
 *   claude  — `claude -p` headless (Claude Code installed, no API key needed)
 *   api-key — direct Anthropic Batch/Messages API (backfill; needs ANTHROPIC_API_KEY)
 * Only `codex` is wired today; the others are declared so the config surface is
 * stable before they land (see "deferred" in the Phase 5 report).
 */
export type ExtractionEngine = "codex" | "claude" | "api-key";

/** Retrieval embedder. "hash" = zero-dependency local char-n-gram (default, works
 *  on clone). "minilm" = all-MiniLM-L6-v2 via Transformers.js (~25MB one-time
 *  download, keyless/offline after) — real semantic recall on paraphrase queries. */
export type EmbedderKind = "hash" | "minilm";

export interface LinksConfig {
  /** Ordered scope rules; the LAST entry is the fallback scope. */
  scopes: ScopeRule[];
  /** Claude Code project dirs that are synthetic corpora — never ingested. */
  excludeProjectDirs: string[];
  /** Where derived cards/index/rules live. Supports leading ~. Default: <repo>/store. */
  storeDir: string;
  /** Per-tool raw session source roots (read-only, never copied). Support leading ~. */
  sources: {
    /** Claude Code transcripts root. Default ~/.claude/projects. */
    claudeProjects: string;
    /** Codex rollout transcripts root. Default ~/.codex/sessions. */
    codexSessions: string;
  };
  /** Card extraction engine. Default "codex". */
  extractionEngine: ExtractionEngine;
  /** Retrieval embedder. Default "hash" (zero-dep). "minilm" for real semantic recall. */
  embedder: EmbedderKind;
  /**
   * Token budget for the SessionStart push (`inject`). The assembler fills tiers
   * in priority order (pinned notes → rules → facts → recent) up to this many
   * tokens (estimated chars/4); lower tiers truncate to fit. Default 1800 — big
   * enough to carry standing rules + a few recent sessions, small enough that the
   * push stays cheap (links' whole edge is being lightweight). */
  injectBudgetTokens: number;
  /** Extraction engine binary override (else auto-discovery). */
  codexBin?: string;
  /**
   * Glob-ish dir + filename used to find a bundled codex binary when none is on
   * PATH. Machine-specific (Cursor's openai.chatgpt extension on this box);
   * lifted to config so other machines/OSes can point elsewhere or disable it.
   */
  codexFallback: {
    /** Directory holding tool extensions. Default ~/.cursor/extensions. */
    extensionsDir: string;
    /** Extension dir name prefix to match. Default "openai.chatgpt-". */
    extensionPrefix: string;
    /** Relative path to the codex binary inside the matched extension. */
    binRelPath: string;
  };
  gate: {
    minSizeKb: number;
    /** Single-shot junk asks — index-only, no card. */
    junkTitleRe: string;
    maxJunkUserTurns: number;
  };
}

/**
 * Defaults = this machine. Anything here is overridable via links.config.json.
 * Keep this object and schema/links.config.schema.json in lockstep.
 */
const DEFAULTS: LinksConfig = {
  // Generic defaults — anyone gets a single "personal" scope. Per-machine scopes
  // (e.g. a "wix" work scope) and machine-specific excludes go in the user's
  // ~/.links/config.json, NOT here — shipping them would leak to every install.
  scopes: [{ name: "personal", cwdPrefix: "~" }],
  excludeProjectDirs: [],
  storeDir: "~/.links/store",
  sources: {
    claudeProjects: "~/.claude/projects",
    codexSessions: "~/.codex/sessions",
  },
  extractionEngine: "codex",
  embedder: "hash",
  injectBudgetTokens: 1800,
  codexFallback: {
    extensionsDir: "~/.cursor/extensions",
    extensionPrefix: "openai.chatgpt-",
    binRelPath: "bin/linux-x86_64/codex",
  },
  gate: {
    minSizeKb: 10,
    junkTitleRe: "^(hi|hello|hey|ls|pwd|cd(\\s+\\S+)?|test|ok|yes|continue)[.!?]?$",
    maxJunkUserTurns: 2,
  },
};

export const ROOT = join(import.meta.dirname, "..");

/** User config location — lives in the user's home so it survives package updates
 *  and is found regardless of CWD or where the package is installed. Override with
 *  LINKS_CONFIG. (Must NOT be the package dir — that's wiped on reinstall.) */
const CONFIG_PATH = process.env.LINKS_CONFIG || join(homedir(), ".links", "config.json");

let cached: LinksConfig | undefined;

/**
 * Load merged config (DEFAULTS ⊕ links.config.json). Shallow-merge top level,
 * deep-merge the nested objects so a partial override (e.g. just `gate.minSizeKb`)
 * doesn't drop the other defaults. Missing/invalid file → pure defaults.
 */
export function config(): LinksConfig {
  if (cached) return cached;
  let user: Partial<LinksConfig> = {};
  try {
    user = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<LinksConfig>;
  } catch {
    user = {};
  }
  cached = {
    ...DEFAULTS,
    ...user,
    storeDir: user.storeDir ?? DEFAULTS.storeDir,
    sources: { ...DEFAULTS.sources, ...user.sources },
    codexFallback: { ...DEFAULTS.codexFallback, ...user.codexFallback },
    gate: { ...DEFAULTS.gate, ...user.gate },
  };
  return cached;
}

/** Test/CLI hook: drop the memoized config so the next config() re-reads. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Deep-partial of LinksConfig — lets tests/overrides supply just a nested key. */
export type PartialConfig = Omit<Partial<LinksConfig>, "sources" | "codexFallback" | "gate"> & {
  sources?: Partial<LinksConfig["sources"]>;
  codexFallback?: Partial<LinksConfig["codexFallback"]>;
  gate?: Partial<LinksConfig["gate"]>;
};

/** Inject a config directly (tests) — bypasses the file read entirely. */
export function setConfigForTest(c: PartialConfig): void {
  cached = {
    ...DEFAULTS,
    ...c,
    storeDir: c.storeDir ?? DEFAULTS.storeDir,
    sources: { ...DEFAULTS.sources, ...c.sources },
    codexFallback: { ...DEFAULTS.codexFallback, ...c.codexFallback },
    gate: { ...DEFAULTS.gate, ...c.gate },
  };
}

/** Expose defaults read-only (init scaffolding, tests). */
export function defaults(): LinksConfig {
  return DEFAULTS;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Resolved (home-expanded) store dir. */
export function storeDir(): string {
  return expandHome(config().storeDir);
}

/** Resolved (home-expanded) per-tool source roots. */
export function claudeProjectsDir(): string {
  return expandHome(config().sources.claudeProjects);
}
export function codexSessionsDir(): string {
  return expandHome(config().sources.codexSessions);
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
