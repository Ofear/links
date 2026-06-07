/**
 * Per-scope sqlite FTS5 index over session metas + cards. Derived data —
 * rebuilt from index.jsonl + cards/*.json at any time via `cli.ts index`.
 */
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cardId as cardIdOf } from "./cards.js";
import type { CardData } from "./extractor.js";
import type { SessionMeta } from "./types.js";

export interface IndexRow {
  card_id: string;
  session_id: string;
  project: string;
  date: string;
  outcome: string;
  intent: string;
  title: string;
  size_kb: number;
  has_card: number;
}

export function openDb(scopeDir: string): Database.Database {
  const db = new Database(join(scopeDir, "links.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      card_id TEXT PRIMARY KEY, session_id TEXT, project TEXT, date TEXT,
      outcome TEXT, intent TEXT, title TEXT, size_kb INTEGER, has_card INTEGER,
      source_path TEXT, meta_json TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
      card_id UNINDEXED, project, intent, title, entities, summary, decisions, issues, rules
    );
  `);
  return db;
}

export async function rebuildScope(scopeDir: string): Promise<{ sessions: number; cards: number }> {
  const db = openDb(scopeDir);
  db.exec("DELETE FROM sessions; DELETE FROM search;");
  const insSession = db.prepare(
    `INSERT INTO sessions VALUES (@card_id,@session_id,@project,@date,@outcome,@intent,@title,@size_kb,@has_card,@source_path,@meta_json)`,
  );
  const insSearch = db.prepare(
    `INSERT INTO search VALUES (@card_id,@project,@intent,@title,@entities,@summary,@decisions,@issues,@rules)`,
  );

  const raw = await readFile(join(scopeDir, "index.jsonl"), "utf8").catch(() => "");
  let cards = 0;
  let sessions = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const meta = JSON.parse(line) as SessionMeta;
    const date = meta.startedAt?.slice(0, 10) ?? "undated";
    const cardId = cardIdOf(meta);
    let card: CardData | undefined;
    try {
      card = (JSON.parse(await readFile(join(scopeDir, "cards", `${cardId}.json`), "utf8")) as { data: CardData }).data;
    } catch {
      /* no card yet — index-only entry */
    }
    insSession.run({
      card_id: cardId,
      session_id: meta.id,
      project: meta.project,
      date,
      outcome: card?.outcome ?? "unknown",
      intent: card?.intent ?? meta.title,
      title: meta.title,
      size_kb: meta.sizeKb,
      has_card: card ? 1 : 0,
      source_path: meta.sourcePath,
      meta_json: line,
    });
    sessions++;
    if (card) {
      cards++;
      const flat = (items: { text: string }[]) => items.map((i) => i.text).join(" \n ");
      insSearch.run({
        card_id: cardId,
        project: meta.project,
        intent: card.intent,
        title: meta.title,
        entities: card.entities.join(" "),
        summary: flat(card.summary),
        decisions: flat(card.decisions),
        issues: flat(card.issues),
        rules: flat(card.rules),
      });
    } else {
      insSearch.run({
        card_id: cardId, project: meta.project, intent: meta.title, title: meta.title,
        entities: meta.toolsUsed.join(" "), summary: "", decisions: "", issues: "", rules: "",
      });
    }
  }
  db.close();
  return { sessions, cards };
}

/** Tier-1 search: compact index lines (~30 tokens each). */
export function searchIndex(scopeDir: string, query: string, limit = 10): IndexRow[] {
  const db = openDb(scopeDir);
  try {
    // sanitize: FTS5 query syntax errors on stray punctuation — quote each term
    const safe = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replaceAll('"', "")}"`)
      .join(" OR ");
    const rows = db
      .prepare(
        `SELECT s.card_id, s.session_id, s.project, s.date, s.outcome, s.intent, s.title, s.size_kb, s.has_card
         FROM search JOIN sessions s ON s.card_id = search.card_id
         WHERE search MATCH ? ORDER BY bm25(search), s.date DESC LIMIT ?`,
      )
      .all(safe, limit) as IndexRow[];
    return rows;
  } finally {
    db.close();
  }
}

export function getSessionRow(scopeDir: string, cardId: string): (IndexRow & { source_path: string }) | undefined {
  const db = openDb(scopeDir);
  try {
    return db.prepare(`SELECT * FROM sessions WHERE card_id = ?`).get(cardId) as
      | (IndexRow & { source_path: string })
      | undefined;
  } finally {
    db.close();
  }
}

export function recentForProject(scopeDir: string, project: string, limit = 10): IndexRow[] {
  const db = openDb(scopeDir);
  try {
    // carded sessions first within recency — an injection slot spent on an
    // uncarded "cd .." line is a slot wasted
    return db
      .prepare(
        `SELECT card_id, session_id, project, date, outcome, intent, title, size_kb, has_card
         FROM sessions WHERE (project = ? OR ? = '') AND length(intent) > 8
         ORDER BY date DESC, has_card DESC LIMIT ?`,
      )
      .all(project, project, limit) as IndexRow[];
  } finally {
    db.close();
  }
}
