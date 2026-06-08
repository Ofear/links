/**
 * links MCP server — the PULL surface. One process per scope:
 *   tsx src/server.ts <scope>     (scope = personal | wix)
 *
 * Progressive-disclosure contract is enforced in the tool descriptions
 * (pattern proven by claude-mem): search → get_card → read_session, never
 * tier-3 without tier-2 first.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readMessagesFor } from "./adapters/index.js";
import { getSessionRow, hybridSearch } from "./db.js";
import { redact } from "./scanner.js";
import { validateCard, freshnessBadge, type FreshnessVerdict } from "./validate.js";

const { scopeNames, storeDir } = await import("./config.js");
const scope = process.argv[2] ?? "";
if (!scopeNames().includes(scope)) {
  console.error(`usage: links serve <${scopeNames().join("|")}>`);
  process.exit(1);
}
// config-driven store (a friend's ~/.links/store), NOT the package install dir
const SCOPE_DIR = join(storeDir(), scope);

function indexLine(r: {
  card_id: string; date: string; project: string; outcome: string; intent: string; size_kb: number; has_card: number;
}): string {
  return `${r.card_id} · ${r.date} · ${r.project} · ${r.outcome} · ${r.intent.slice(0, 110)}${r.has_card ? "" : " [index-only]"}`;
}

const server = new McpServer({ name: `links-${scope}`, version: "0.1.0" });

server.registerTool(
  "search",
  {
    description:
      "STEP 1 of the links workflow. HYBRID search past coding sessions (intent, summaries, " +
      "decisions, issues, entities, user rules): fuses keyword/BM25 with semantic vector " +
      "similarity, so PARAPHRASE queries match too (e.g. 'speed up the build' finds 'reduce " +
      "webpack compile time'). Returns compact index lines (~30 tokens each), each annotated " +
      "with WHY it matched (lexical / semantic / both). " +
      "Results are FRESHNESS-RANKED: each hit is validated against the CURRENT code (the files " +
      "it touched, vs git history) and memory that no longer matches reality sinks — a hit " +
      "tagged [⚠ stale] means the files changed since, [⛔ code moved] means cited code is gone " +
      "(verify before trusting implementation details; decisions/rationale still hold). " +
      "ALWAYS start here before re-investigating anything that may have been solved before. " +
      "Then call get_card on promising hits — NEVER read_session without get_card first. " +
      `NOTE: this server covers the '${scope}' scope only; machine/system-level fixes (VPN, ` +
      "drivers, OS, desktop apps) live in links-personal — query that server for those.",
    inputSchema: {
      query: z.string().describe("keywords OR natural-language description: error codes, file names, services, intents"),
      limit: z.number().int().min(1).max(25).default(10),
    },
  },
  async ({ query, limit }) => {
    // over-fetch, then re-rank by FRESHNESS: stale/broken memory sinks below
    // still-true memory. links ranks by "is it still true?" — not just similarity.
    const pool = hybridSearch(SCOPE_DIR, query, Math.min(limit * 3, 30));
    const judged = await Promise.all(
      pool.map(async (r) => {
        const v = await cardVerdict(r.card_id);
        return { r, v, adj: r.score * freshnessFactor(v) };
      }),
    );
    judged.sort((a, b) => b.adj - a.adj);
    const top = judged.slice(0, limit);
    return {
      content: [{
        type: "text",
        text: top.length
          ? top
              .map(({ r, v, adj }) => `${indexLine(r)}${freshnessSuffix(v)}\n    ↳ matched via ${r.why} · score ${adj.toFixed(2)} (freshness-ranked)`)
              .join("\n")
          : "No matching past sessions. This appears to be new ground — proceed with fresh investigation.",
      }],
    };
  },
);

server.registerTool(
  "get_card",
  {
    description:
      "STEP 2. Fetch the full metadata card (~300-500 tokens) for one session: summary with " +
      "evidence pointers [msgs N–M], decisions with rationale, issues, user rules. Use it to " +
      "decide if the session answers your question — often the card alone is enough.",
    inputSchema: { card_id: z.string().describe("card id from search, e.g. cc-2026-06-07-520b8330") },
  },
  async ({ card_id }) => {
    const md = await readFile(join(SCOPE_DIR, "cards", `${card_id}.md`), "utf8").catch(() => null);
    if (md) {
      const notes = (await Promise.all([liveStatusLine(card_id), stalenessLine(card_id)]))
        .filter((s): s is string => !!s);
      return { content: [{ type: "text", text: notes.length ? `${md}\n${notes.join("\n")}` : md }] };
    }
    const row = getSessionRow(SCOPE_DIR, card_id);
    return {
      content: [{
        type: "text",
        text: row
          ? `No card (index-only session). Meta: ${row.title} — use read_session(${card_id}) only if the title strongly matches.`
          : `Unknown card_id ${card_id}.`,
      }],
    };
  },
);

/**
 * Query-time liveness: is the source session still running, or has it grown
 * past what the card summarizes? Disambiguates `outcome: partial` (work
 * incomplete) from "carded mid-flight". Computed live — never stored.
 */
async function liveStatusLine(cardId: string): Promise<string | null> {
  const row = getSessionRow(SCOPE_DIR, cardId);
  if (!row) return null;
  const { stat } = await import("node:fs/promises");
  const s = await stat(row.source_path).catch(() => null);
  if (!s) return "⚠ source transcript no longer exists — this card is the only record; read_session will fail.";
  const ageMin = Math.round((Date.now() - s.mtimeMs) / 60000);
  const nowKb = Math.floor(s.size / 1024);
  // carding-time size from the card JSON (cards written before 2026-06-07 lack it — fail quiet)
  const cardedKb = await readFile(join(SCOPE_DIR, "cards", `${cardId}.json`), "utf8")
    .then((raw) => (JSON.parse(raw) as { source_size_kb?: number }).source_size_kb)
    .catch(() => undefined);
  if (ageMin < 15) {
    return `⏳ session appears ACTIVE (transcript modified ${ageMin}m ago${cardedKb ? `; carded at ${cardedKb}KB, now ${nowKb}KB` : ""}) — this card is a snapshot; read_session reaches the latest messages.`;
  }
  if (cardedKb && nowKb > cardedKb * 1.1 + 50) {
    return `⚠ session grew after carding (${cardedKb}KB → ${nowKb}KB) — recent work is NOT summarized here; read_session covers it, and the next refresh re-cards.`;
  }
  return null;
}

/**
 * Query-time freshness: validate the files this session touched against current
 * reality. Uses the git-SHA diff when a commit was recorded (the strong signal),
 * else falls back to mtime-vs-endedAt. Computed live — never stored, never stale.
 * (Delegates to validate.ts; the git-SHA path is the leapfrog over mtime-only.)
 */
async function cardVerdict(cardId: string): Promise<FreshnessVerdict | null> {
  const row = getSessionRow(SCOPE_DIR, cardId);
  if (!row) return null;
  const meta = JSON.parse((row as unknown as { meta_json: string }).meta_json) as {
    filesTouched?: string[];
    endedAt?: string;
    cwd?: string;
    gitCommit?: string;
    gitBranch?: string;
  };
  if (!meta.filesTouched?.length) return null;
  return validateCard({
    filesTouched: meta.filesTouched,
    endedAt: meta.endedAt,
    cwd: meta.cwd,
    gitCommit: meta.gitCommit,
    gitBranch: meta.gitBranch,
  });
}

/** Full freshness badge for get_card; null when nothing actionable to surface. */
async function stalenessLine(cardId: string): Promise<string | null> {
  const v = await cardVerdict(cardId);
  // suppress the no-signal 'unknown' case to avoid noise; fresh/stale/broken are actionable.
  if (!v || v.freshness === "unknown") return null;
  return freshnessBadge(v);
}

/** Compact per-hit suffix for search index lines — only the actionable warnings. */
function freshnessSuffix(v: FreshnessVerdict | null): string {
  return v?.freshness === "stale" ? "  [⚠ stale]"
    : v?.freshness === "broken" ? "  [⛔ code moved]"
    : "";
}

/**
 * Truth-aware ranking multiplier. links ranks by "is this memory still true
 * against the current code?", not just similarity+recency — the axis competitors
 * (total-recall, claude-mem, mem0) are structurally blind to. A card whose code
 * is gone sinks below a slightly-less-similar card that still holds.
 */
function freshnessFactor(v: FreshnessVerdict | null): number {
  switch (v?.freshness) {
    case "broken": return 0.4; // cited code is gone — demote hard, but keep visible
    case "stale": return 0.85; // file moved since the card — mild demote
    case "fresh": return 1.05; // verified still-true — slight boost
    default: return 1.0; // unknown / no signal — neutral
  }
}

server.registerTool(
  "read_session",
  {
    description:
      "STEP 3 (expensive). Read a slice of the raw transcript. ALWAYS pass msg_from/msg_to from " +
      "a card's evidence pointers [msgs N–M] — full-session reads can be 100k+ tokens. " +
      "Only use after get_card confirmed relevance.",
    inputSchema: {
      card_id: z.string(),
      msg_from: z.number().int().min(0).optional(),
      msg_to: z.number().int().min(0).optional(),
    },
  },
  async ({ card_id, msg_from, msg_to }) => {
    const row = getSessionRow(SCOPE_DIR, card_id);
    if (!row) return { content: [{ type: "text", text: `Unknown card_id ${card_id}.` }] };
    const rowMeta = JSON.parse((row as unknown as { meta_json: string }).meta_json) as { tool: string };
    const messages = await readMessagesFor({ tool: rowMeta.tool as "claude-code", sourcePath: row.source_path });
    const from = msg_from ?? 0;
    const to = msg_to ?? Math.min(from + 40, messages.length - 1);
    const slice = messages.filter((m) => m.index >= from && m.index <= to);
    const rendered = slice
      .map((m) => {
        const tools = m.toolUses?.map((t) => (t.target ? `${t.name}(${t.target})` : t.name)).join(", ");
        const results = (m.toolResults ?? []).map((r) => `  [result] ${r.slice(0, 700)}`).join("\n");
        return `[msg ${m.index}] ${m.role.toUpperCase()}${tools ? ` (${tools})` : ""}: ${m.text.slice(0, 2500)}${results ? "\n" + results : ""}`;
      })
      .join("\n");
    return {
      content: [{
        type: "text",
        text: redact(`Transcript slice msgs ${from}–${to} of ${messages.length} (${card_id}):\n${rendered}`).text,
      }],
    };
  },
);

server.registerTool(
  "expand_links",
  {
    description:
      "Traverse the session graph from one card: what supersedes it (NEWER state — follow " +
      "these), what it supersedes, and related sessions (shared files/entities). Use after " +
      "get_card when a card looks relevant but possibly stale, or to find sibling work.",
    inputSchema: { card_id: z.string() },
  },
  async ({ card_id }) => {
    const graph = JSON.parse(
      await readFile(join(SCOPE_DIR, "links.json"), "utf8").catch(() => "{}"),
    ) as Record<string, { relatesTo: string[]; supersedes: string[]; supersededBy: string[] }>;
    const e = graph[card_id];
    if (!e) return { content: [{ type: "text", text: `No edges for ${card_id}.` }] };
    const describe = (entry: string) => {
      // relates-to edges encode "<id>|<why>"; supersede edges are bare ids
      const [id, why] = entry.split("|");
      const row = getSessionRow(SCOPE_DIR, id!);
      const line = row ? indexLine(row) : id!;
      return why ? `${line}  ← ${why}` : line;
    };
    const parts: string[] = [];
    if (e.supersededBy.length) parts.push(`⚠ SUPERSEDED BY (read these for current state):\n${e.supersededBy.map(describe).join("\n")}`);
    if (e.supersedes.length) parts.push(`supersedes (older state):\n${e.supersedes.map(describe).join("\n")}`);
    if (e.relatesTo.length) parts.push(`related:\n${e.relatesTo.map(describe).join("\n")}`);
    return { content: [{ type: "text", text: parts.join("\n\n") || "No edges." }] };
  },
);

server.registerTool(
  "pin_note",
  {
    description:
      "Pin a durable 'sticky note' to this project's memory — it will be injected into EVERY " +
      "future session's context. Use for facts worth remembering across sessions: ports, " +
      "credentials locations (never values), environment quirks, key decisions, gotchas. " +
      "Keep it one line. Use when the user says 'remember this' or when you discover " +
      "something every future session will need.",
    inputSchema: {
      project: z.string().describe("project name (directory basename, e.g. 'glow-up')"),
      note: z.string().max(300).describe("one-line durable fact"),
    },
  },
  async ({ project, note }) => {
    const { pinNote } = await import("./rules.js");
    const { redact } = await import("./scanner.js");
    const path = await pinNote(SCOPE_DIR, project, redact(note).text, "agent");
    return { content: [{ type: "text", text: `Pinned to ${path} — will appear in every future ${project} session.` }] };
  },
);

await server.connect(new StdioServerTransport());
