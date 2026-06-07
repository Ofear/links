/**
 * Claude Code adapter.
 *
 * Source (verified 2026-06-07): ~/.claude/projects/<project-dir>/<uuid>.jsonl
 * Exclusions (verified — Phase 0 discovery): synthetic corpora must never reach
 * the index:
 *   - any path containing "/subagents/"
 *   - project dirs in EXCLUDED_PROJECT_DIRS (claude-mem observer re-narrations
 *     were 93% of raw files and would drown retrieval in duplicates)
 *
 * MESSAGE-INDEX RULE (stable, load-bearing — evidence pointers depend on it):
 * index = 0-based ordinal of JSONL records with type "user" or "assistant",
 * counted in file order, INCLUDING meta/tool-result-only records. Counting all
 * such records (rather than only "real" ones) keeps the rule trivially
 * deterministic against future heuristic changes.
 *
 * Contract: fail LOUD. An unparseable session returns a stub (gate:
 * index-only, reason "unparseable") rather than being silently dropped.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { claudeProjectsDir, config, scopeForCwd as scopeOf } from "../config.js";
import type { GateDecision, NormalizedMessage, SessionMeta } from "../types.js";

const ROOT = claudeProjectsDir();

const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const EXCERPT_LEN = 220;

function clean(text: string): string {
  return text.split(/\s+/).join(" ").slice(0, EXCERPT_LEN);
}

function projectLabel(cwd: string): string {
  if (!cwd || cwd === "/") return "system";
  const home = homedir();
  if (cwd === home) return "home";
  return basename(cwd);
}

interface RawRecord {
  type?: string;
  isMeta?: boolean;
  cwd?: string;
  timestamp?: string;
  gitBranch?: string;
  summary?: string;
  message?: { role?: string; model?: string; content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/** Text of tool_result blocks (command outputs etc.) — the root-cause evidence. */
function toolResultTextOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object" || (b as { type?: string }).type !== "tool_result") continue;
    const inner = (b as { content?: unknown }).content;
    const text = typeof inner === "string" ? inner : textOf(inner);
    if (text.trim()) out.push(text);
  }
  return out;
}

function toolUsesOf(content: unknown): { name: string; target?: string }[] {
  if (!Array.isArray(content)) return [];
  const uses: { name: string; target?: string }[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "tool_use") {
      const block = b as { name?: string; input?: { file_path?: string } };
      if (block.name) uses.push({ name: block.name, target: block.input?.file_path });
    }
  }
  return uses;
}

async function* records(path: string): AsyncGenerator<RawRecord> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RawRecord;
    } catch {
      // tolerate individual corrupt lines; whole-file failures surface in scanSession
    }
  }
}

/** List candidate session files, applying the synthetic-corpus exclusions. */
export async function listSessionFiles(): Promise<string[]> {
  const out: string[] = [];
  const excluded = new Set(config().excludeProjectDirs);
  for (const dir of await readdir(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory() || excluded.has(dir.name)) continue;
    const dirPath = join(ROOT, dir.name);
    for (const f of await readdir(dirPath)) {
      if (f.endsWith(".jsonl")) out.push(join(dirPath, f));
    }
    // intentionally NOT recursing: subagent transcripts live in subdirectories
  }
  return out;
}

/** One streaming pass over a transcript → SessionMeta (no content copied). */
export async function scanSession(path: string): Promise<SessionMeta> {
  const sizeKb = Math.floor((await stat(path)).size / 1024);
  const meta: SessionMeta = {
    id: basename(path, ".jsonl"),
    tool: "claude-code",
    scope: "personal",
    project: "unknown",
    cwd: "",
    sourcePath: path,
    sizeKb,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolsUsed: [],
    filesTouched: [],
    title: "",
    msgCount: 0,
    gate: { verdict: "index-only", reason: "pending" },
  };
  const tools = new Set<string>();
  const files = new Set<string>();
  let summary: string | undefined;
  let firstMsg: string | undefined;
  let lastTs: string | undefined;

  try {
    for await (const rec of records(path)) {
      if (rec.type === "summary" && !summary && rec.summary) summary = rec.summary;
      if (rec.type !== "user" && rec.type !== "assistant") continue;
      meta.msgCount++;
      if (rec.cwd && !meta.cwd) meta.cwd = rec.cwd;
      if (rec.timestamp) {
        meta.startedAt ??= rec.timestamp;
        lastTs = rec.timestamp;
      }
      if (rec.gitBranch && !meta.gitBranch) meta.gitBranch = rec.gitBranch;
      if (rec.type === "assistant") {
        meta.assistantTurns++;
        meta.model ??= rec.message?.model;
        for (const u of toolUsesOf(rec.message?.content)) {
          meta.toolCalls++;
          tools.add(u.name);
          if (FILE_WRITE_TOOLS.has(u.name) && u.target) files.add(u.target);
        }
      } else if (!rec.isMeta) {
        const text = textOf(rec.message?.content).trim();
        if (text && !text.startsWith("<")) {
          meta.userTurns++;
          firstMsg ??= text;
        }
      }
    }
  } catch (err) {
    meta.gate = { verdict: "index-only", reason: `unparseable: ${String(err)}` };
    meta.title = clean(firstMsg ?? summary ?? "(unparseable session)");
    return meta;
  }

  meta.endedAt = lastTs;
  meta.scope = scopeOf(meta.cwd);
  meta.project = projectLabel(meta.cwd);
  meta.toolsUsed = [...tools].sort();
  meta.filesTouched = [...files].sort();
  meta.title = clean(summary ?? firstMsg ?? "(no user message)");
  meta.gate = gateOf(meta);
  return meta;
}

/** Triviality gate: tiny, turn-less, or junk-ask sessions get an index line, no card. */
export function gateOf(meta: SessionMeta): GateDecision {
  const g = config().gate;
  if (meta.userTurns === 0) return { verdict: "index-only", reason: "no real user turns" };
  if (meta.sizeKb < g.minSizeKb) return { verdict: "index-only", reason: `tiny (${meta.sizeKb}KB)` };
  if (meta.userTurns <= g.maxJunkUserTurns && new RegExp(g.junkTitleRe, "i").test(meta.title.trim())) {
    return { verdict: "index-only", reason: `junk title ("${meta.title.slice(0, 20)}")` };
  }
  return { verdict: "card" };
}

/**
 * Full message read for extraction (tier-3 path). Indices follow the
 * MESSAGE-INDEX RULE above and therefore align with scanSession's msgCount.
 */
export async function readMessages(path: string): Promise<NormalizedMessage[]> {
  const out: NormalizedMessage[] = [];
  let index = 0;
  for await (const rec of records(path)) {
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const role = rec.type;
    const toolUses = role === "assistant" ? toolUsesOf(rec.message?.content) : [];
    const toolResults = role === "user" ? toolResultTextOf(rec.message?.content) : [];
    out.push({
      index: index++,
      role,
      text: textOf(rec.message?.content),
      ...(toolUses.length ? { toolUses } : {}),
      ...(toolResults.length ? { toolResults } : {}),
      ...(rec.timestamp ? { timestamp: rec.timestamp } : {}),
    });
  }
  return out;
}
