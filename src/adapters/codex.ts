/**
 * Codex CLI adapter.
 *
 * Source (verified 2026-06-07): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * (NOT ~/.codex/history.jsonl — that holds prompts only, no transcripts).
 *
 * Record envelope: {type, payload, timestamp}
 *   session_meta  → payload {id, cwd, git, timestamp, model_provider, ...}
 *   response_item → payload.type ∈ message | reasoning | function_call |
 *                   function_call_output | custom_tool_call | ...
 *   event_msg / turn_context → skipped
 *
 * MESSAGE-INDEX RULE (stable, load-bearing): index = 0-based ordinal of
 * response_item records whose payload.type is "message" (role user/assistant),
 * "function_call", or "function_call_output", in file order. developer-role
 * messages (harness instructions) are skipped and do NOT consume an index.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { codexSessionsDir, scopeForCwd } from "../config.js";
import { gateOf } from "./claudeCode.js";
import type { NormalizedMessage, SessionMeta } from "../types.js";

const ROOT = codexSessionsDir();
const EXCERPT_LEN = 220;

interface Envelope {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    git?: { branch?: string; commit_hash?: string };
    timestamp?: string;
    role?: string;
    content?: { type?: string; text?: string }[];
    name?: string;
    arguments?: string;
    output?: unknown;
  };
}

function clean(text: string): string {
  return text.split(/\s+/).join(" ").slice(0, EXCERPT_LEN);
}

function textOf(content: { type?: string; text?: string }[] | undefined): string {
  return (content ?? [])
    .filter((c) => c.type === "input_text" || c.type === "output_text" || c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ")
    .trim();
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as { content?: unknown; output?: unknown };
    if (typeof o.content === "string") return o.content;
    if (typeof o.output === "string") return o.output;
    return JSON.stringify(output).slice(0, 2000);
  }
  return "";
}

async function* records(path: string): AsyncGenerator<Envelope> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as Envelope;
    } catch { /* tolerate corrupt lines */ }
  }
}

export async function listSessionFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(ROOT);
  return out;
}

/** True for an indexable response_item per the MESSAGE-INDEX RULE. */
function indexable(env: Envelope): boolean {
  if (env.type !== "response_item") return false;
  const p = env.payload ?? {};
  if (p.type === "message") return p.role === "user" || p.role === "assistant";
  return p.type === "function_call" || p.type === "function_call_output";
}

export async function scanSession(path: string): Promise<SessionMeta> {
  const sizeKb = Math.floor((await stat(path)).size / 1024);
  const meta: SessionMeta = {
    id: basename(path, ".jsonl").replace(/^rollout-[0-9T-]+-/, ""),
    tool: "codex",
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
  let firstMsg: string | undefined;
  let lastTs: string | undefined;
  try {
    for await (const env of records(path)) {
      if (env.type === "session_meta") {
        const p = env.payload ?? {};
        meta.cwd = p.cwd ?? "";
        meta.startedAt = p.timestamp ?? env.timestamp;
        if (p.git?.branch) meta.gitBranch = p.git.branch;
        if (p.git?.commit_hash) meta.gitCommit = p.git.commit_hash;
        if (p.id) meta.id = p.id;
        continue;
      }
      if (!indexable(env)) continue;
      meta.msgCount++;
      if (env.timestamp) lastTs = env.timestamp;
      const p = env.payload!;
      if (p.type === "message" && p.role === "user") {
        const text = textOf(p.content);
        if (text && !text.startsWith("<")) {
          meta.userTurns++;
          firstMsg ??= text;
        }
      } else if (p.type === "message" && p.role === "assistant") {
        meta.assistantTurns++;
      } else if (p.type === "function_call") {
        meta.toolCalls++;
        if (p.name) tools.add(p.name);
      }
    }
  } catch (err) {
    meta.gate = { verdict: "index-only", reason: `unparseable: ${String(err)}` };
    return meta;
  }
  meta.endedAt = lastTs;
  meta.scope = scopeForCwd(meta.cwd);
  meta.project = meta.cwd && meta.cwd !== "/" ? basename(meta.cwd) : "system";
  meta.toolsUsed = [...tools].sort();
  meta.title = clean(firstMsg ?? "(no user message)");
  meta.gate = gateOf(meta);
  return meta;
}

export async function readMessages(path: string): Promise<NormalizedMessage[]> {
  const out: NormalizedMessage[] = [];
  let index = 0;
  for await (const env of records(path)) {
    if (!indexable(env)) continue;
    const p = env.payload!;
    if (p.type === "message") {
      out.push({
        index: index++,
        role: p.role as "user" | "assistant",
        text: textOf(p.content),
        ...(env.timestamp ? { timestamp: env.timestamp } : {}),
      });
    } else if (p.type === "function_call") {
      out.push({
        index: index++,
        role: "assistant",
        text: "",
        toolUses: [{ name: p.name ?? "unknown", target: p.arguments?.slice(0, 120) }],
        ...(env.timestamp ? { timestamp: env.timestamp } : {}),
      });
    } else {
      // function_call_output
      out.push({
        index: index++,
        role: "user",
        text: "",
        toolResults: [outputText(p.output)],
        ...(env.timestamp ? { timestamp: env.timestamp } : {}),
      });
    }
  }
  return out;
}
