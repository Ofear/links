/**
 * Core types. Invariant: raw transcripts are immutable ground truth owned by the
 * tools; everything here is DERIVED and rebuildable. SessionMeta stores pointers
 * and counts — never copies of transcript content beyond a short title.
 */

export type Tool = "claude-code" | "codex" | "cursor";
/** Scope names come from links.config.json scope rules (e.g. "personal", "wix"). */
export type Scope = string;

/** Gate decision: does this session deserve a card (LLM extraction)? */
export type GateDecision =
  | { verdict: "card" }
  | { verdict: "index-only"; reason: string };

export interface SessionMeta {
  id: string;
  tool: Tool;
  scope: Scope;
  /** Human project label derived from cwd (e.g. "glow-up", "Personal"). */
  project: string;
  cwd: string;
  /** Absolute path to the raw transcript — the pointer, never a copy. */
  sourcePath: string;
  sizeKb: number;
  startedAt?: string;
  endedAt?: string;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  /** Distinct tool names invoked (Bash, Edit, mcp:..., etc.). */
  toolsUsed: string[];
  /** Files written via Edit/Write/NotebookEdit tool calls. */
  filesTouched: string[];
  model?: string;
  gitBranch?: string;
  /** Commit SHA at session start. Codex session_meta records it; Claude Code
   * transcripts do NOT (verified 2026-06-07: records carry gitBranch only) —
   * never substitute a scan-time `rev-parse`, that would record the wrong commit. */
  gitCommit?: string;
  /** First real user ask (or session summary), cleaned, ≤220 chars. */
  title: string;
  /** Total indexed messages — see message-index rule in adapters/claudeCode.ts. */
  msgCount: number;
  gate: GateDecision;
}

/**
 * A transcript message with a STABLE index. Evidence pointers on cards
 * ([msgs N–M]) refer to these indices, so the indexing rule must be
 * deterministic and never change between adapter runs.
 */
export interface NormalizedMessage {
  index: number;
  role: "user" | "assistant";
  /** Concatenated text blocks (may be empty for pure tool-use messages). */
  text: string;
  toolUses?: { name: string; target?: string }[];
  /** tool_result block texts on user records — command outputs, the evidence. */
  toolResults?: string[];
  timestamp?: string;
}
