/**
 * Card writer — tier-2 markdown with YAML frontmatter + [[wikilinks]] syntax
 * (basic-memory-compatible). Final markdown passes through the secret scanner
 * again: cards travel further than transcripts.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTRACTOR_VERSION, type CardData, type EvidencedItem } from "./extractor.js";
import { redact } from "./scanner.js";
import type { SessionMeta } from "./types.js";

const TOOL_PREFIX: Record<string, string> = { "claude-code": "cc", codex: "cx", cursor: "cu" };

/** SINGLE source of truth for card ids — every component must use this. */
export function cardId(meta: Pick<SessionMeta, "tool" | "id" | "startedAt">): string {
  const date = meta.startedAt?.slice(0, 10) ?? "undated";
  // Use full session UUID (36 chars) to guarantee uniqueness across all tools.
  // Codex sessions in particular share common UUID prefixes (e.g. 019e942...)
  // causing collisions with shorter slices. The full ID is the source of truth.
  return `${TOOL_PREFIX[meta.tool] ?? "xx"}-${date}-${meta.id}`;
}

function section(title: string, items: EvidencedItem[]): string {
  if (!items.length) return "";
  const lines = items.map((i) => `- ${i.text}  [msgs ${i.msgs[0]}–${i.msgs[1]}]`);
  return `## ${title}\n${lines.join("\n")}\n`;
}

function yamlList(items: string[]): string {
  return items.length ? `[${items.map((s) => JSON.stringify(s)).join(", ")}]` : "[]";
}

function durationOf(start?: string, end?: string): string {
  if (!start || !end) return "unknown";
  const mins = Math.round((Date.parse(end) - Date.parse(start)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return "unknown";
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

export interface CardLinks {
  relatesTo: string[];
  supersedes: string[];
  supersededBy: string[];
}

export function renderCard(meta: SessionMeta, data: CardData, links?: CardLinks): string {
  const fm = [
    "---",
    `id: ${cardId(meta)}`,
    `tool: ${meta.tool}`,
    `scope: ${meta.scope}`,
    `project: ${meta.project}`,
    `session: ${meta.sourcePath}`,
    `date: ${meta.startedAt?.slice(0, 10) ?? "unknown"}`,
    `ended: ${meta.endedAt?.slice(0, 19) ?? "unknown"}`,
    `duration: ${durationOf(meta.startedAt, meta.endedAt)}`,
    `outcome: ${data.outcome}`,
    `extractor_version: ${EXTRACTOR_VERSION}`,
    `intent: ${JSON.stringify(data.intent)}`,
    `git_branch: ${meta.gitBranch ?? "unknown"}`,
    // commit SHA only where ground truth records one (Codex) — never faked from scan-time HEAD
    ...(meta.gitCommit ? [`git_commit: ${meta.gitCommit}`] : []),
    `model: ${meta.model ?? "unknown"}`,
    `size_kb: ${meta.sizeKb}`,
    // prices the tier-3 decision: rough full-transcript read cost (bytes/4 heuristic)
    `est_full_read_tokens: ~${Math.max(1, Math.round(meta.sizeKb / 4))}k`,
    `user_turns: ${meta.userTurns}`,
    `msg_count: ${meta.msgCount}`,
    `tools_used: ${yamlList(meta.toolsUsed)}`,
    `files_touched_count: ${meta.filesTouched.length}`,
    // list capped for card size — but never silently: the count above is the truth
    `files_touched: ${yamlList(meta.filesTouched.slice(0, 25))}${meta.filesTouched.length > 25 ? ` # first 25 of ${meta.filesTouched.length}` : ""}`,
    `entities: ${yamlList(data.entities)}`,
    "---",
  ].join("\n");

  const linkLines: string[] = [];
  if (links?.supersededBy.length) {
    // shown FIRST — an agent landing on a superseded card must see it immediately
    linkLines.push(...links.supersededBy.map((id) => `- ⚠ superseded-by [[${id}]] — read that card instead for current state`));
  }
  if (links?.supersedes.length) linkLines.push(...links.supersedes.map((id) => `- supersedes [[${id}]]`));
  if (links?.relatesTo.length) {
    linkLines.push(...links.relatesTo.map((entry) => {
      const [id, why] = entry.split("|"); // edges encode "<id>|<why>"; why may be absent on legacy graphs
      return why ? `- relates-to [[${id}]] (${why})` : `- relates-to [[${id}]]`;
    }));
  }
  if (!linkLines.length) linkLines.push("- (no high-confidence links)");

  const body = [
    section("Summary", data.summary),
    section("Decisions", data.decisions),
    section("Issues flagged", data.issues),
    section("Rules set by user", data.rules),
    `## Links\n${linkLines.join("\n")}\n`,
  ]
    .filter(Boolean)
    .join("\n");

  return redact(`${fm}\n\n${body}`).text;
}

export async function writeCard(storeDir: string, meta: SessionMeta, data: CardData): Promise<string> {
  const base = join(storeDir, meta.scope, "cards", cardId(meta));
  // JSON = the extraction (expensive, source); md = derived view (re-renderable free).
  // source_size_kb lets refresh detect resumed/grown sessions and re-card them.
  await writeFile(
    `${base}.json`,
    JSON.stringify({ extractor_version: EXTRACTOR_VERSION, source_size_kb: meta.sizeKb, data }, null, 1),
  );
  const path = `${base}.md`;
  await writeFile(path, renderCard(meta, data));
  return path;
}
