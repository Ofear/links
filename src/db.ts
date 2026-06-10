/**
 * Per-scope sqlite FTS5 index over session metas + cards. Derived data —
 * rebuilt from index.jsonl + cards/*.json at any time via `cli.ts index`.
 */
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cardId as cardIdOf } from "./cards.js";
import type { CardData } from "./extractor.js";
import {
  type Candidate,
  blobToVector,
  cosine,
  defaultEmbedder,
  type Embedder,
  fuse,
  type ScoredCard,
  vectorToBlob,
} from "./retrieval.js";
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
    -- Per-card semantic vectors for hybrid retrieval. embedder_id stamps the
    -- model so a model swap can be detected and the table rebuilt. Brute-force
    -- cosine at query time (corpus is small) — no sqlite-vec dependency.
    CREATE TABLE IF NOT EXISTS vectors (
      card_id TEXT PRIMARY KEY, embedder_id TEXT, vec BLOB
    );
  `);
  return db;
}

/**
 * Concatenated searchable text for a card — the same fields FTS5 indexes, so
 * lexical and semantic signals see the same content. Used for embedding.
 */
function embedText(parts: {
  project: string; intent: string; title: string; entities: string;
  summary: string; decisions: string; issues: string; rules: string;
}): string {
  return [parts.intent, parts.title, parts.entities, parts.summary, parts.decisions, parts.issues, parts.rules, parts.project]
    .filter(Boolean)
    .join("\n");
}

export async function rebuildScope(scopeDir: string): Promise<{ sessions: number; cards: number }> {
  const db = openDb(scopeDir);
  db.exec("DELETE FROM sessions; DELETE FROM search; DELETE FROM vectors;");
  const insSession = db.prepare(
    `INSERT INTO sessions VALUES (@card_id,@session_id,@project,@date,@outcome,@intent,@title,@size_kb,@has_card,@source_path,@meta_json)`,
  );
  const insSearch = db.prepare(
    `INSERT INTO search VALUES (@card_id,@project,@intent,@title,@entities,@summary,@decisions,@issues,@rules)`,
  );
  const insVec = db.prepare(`INSERT INTO vectors VALUES (@card_id,@embedder_id,@vec)`);
  // Embedding is the only step that could fail without a model present; the
  // default embedder is pure-local and deterministic, so it never does — but we
  // guard anyway so a future model-backed embedder degrades to FTS5-only
  // (search() falls back when the vectors table is empty).
  let embedder: Embedder | undefined;
  try {
    embedder = defaultEmbedder();
  } catch {
    embedder = undefined; // no embeddings available → FTS5-only index, still works
  }
  const indexVector = async (cardId: string, text: string) => {
    if (!embedder) return;
    try {
      insVec.run({ card_id: cardId, embedder_id: embedder.id, vec: vectorToBlob(await embedder.embed(text)) });
    } catch {
      /* one bad embed must not abort the whole rebuild */
    }
  };

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
      const fields = {
        card_id: cardId,
        project: meta.project,
        intent: card.intent,
        title: meta.title,
        entities: card.entities.join(" "),
        summary: flat(card.summary),
        decisions: flat(card.decisions),
        issues: flat(card.issues),
        rules: flat(card.rules),
      };
      insSearch.run(fields);
      await indexVector(cardId, embedText(fields));
    } else {
      const fields = {
        card_id: cardId, project: meta.project, intent: meta.title, title: meta.title,
        entities: meta.toolsUsed.join(" "), summary: "", decisions: "", issues: "", rules: "",
      };
      insSearch.run(fields);
      await indexVector(cardId, embedText(fields));
    }
  }
  db.close();
  return { sessions, cards };
}

/** Tier-1 search: compact index lines (~30 tokens each). */
/**
 * Cards hidden from default search by the dedup pass (consolidation.json `hidden`).
 * Still reachable by id / get_card / expand_links — never deleted. Cached per
 * scopeDir by file mtime so a fresh `link` run is picked up without restart.
 */
const hiddenCache = new Map<string, { mtimeMs: number; ids: Set<string> }>();
export function loadHidden(scopeDir: string): Set<string> {
  const path = join(scopeDir, "consolidation.json");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return new Set(); // no consolidation.json yet — nothing hidden
  }
  const cached = hiddenCache.get(scopeDir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.ids;
  let ids = new Set<string>();
  try {
    ids = new Set((JSON.parse(readFileSync(path, "utf8")) as { hidden?: string[] }).hidden ?? []);
  } catch {
    ids = new Set();
  }
  hiddenCache.set(scopeDir, { mtimeMs, ids });
  return ids;
}

export function searchIndex(scopeDir: string, query: string, limit = 10): IndexRow[] {
  const db = openDb(scopeDir);
  try {
    // sanitize: FTS5 query syntax errors on stray punctuation — quote each term
    const safe = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replaceAll('"', "")}"`)
      .join(" OR ");
    // over-fetch by the hidden count so dedup-hidden cards don't shrink results
    const hidden = loadHidden(scopeDir);
    const rows = (db
      .prepare(
        `SELECT s.card_id, s.session_id, s.project, s.date, s.outcome, s.intent, s.title, s.size_kb, s.has_card
         FROM search JOIN sessions s ON s.card_id = search.card_id
         WHERE search MATCH ? ORDER BY bm25(search), s.date DESC LIMIT ?`,
      )
      .all(safe, limit + hidden.size) as IndexRow[])
      .filter((r) => !hidden.has(r.card_id))
      .slice(0, limit);
    return rows;
  } finally {
    db.close();
  }
}

export interface HybridRow extends IndexRow {
  /** Fused score in [0,1]. */
  score: number;
  /** WHY this card matched — which signals fired (lexical/semantic) and how strongly. */
  why: string;
}

/**
 * Tier-1 HYBRID search: fuse FTS5/BM25 (lexical) with vector cosine (semantic).
 *
 * Pipeline:
 *  1. Lexical: FTS5 MATCH over the candidate pool (wider limit so the fusion has
 *     room to re-rank). Carries bm25() for each hit.
 *  2. Semantic: embed the query, brute-force cosine over the vectors table.
 *     UNION with lexical hits — a paraphrase-only match has no FTS5 row but
 *     should still surface (the whole reason for hybrid).
 *  3. Fuse + explain (see retrieval.ts), then hydrate to IndexRows.
 *
 * GRACEFUL DEGRADATION: if the vectors table is empty (no embedder available at
 * index time) or the query can't be embedded, semantic candidates are simply
 * absent and fusion runs lexical-only — identical ranking to the old FTS5 path.
 * The tool never stops working because embeddings are missing.
 */
export async function hybridSearch(
  scopeDir: string,
  query: string,
  limit = 10,
  embedder: Embedder | undefined = defaultEmbedderOrNull(),
): Promise<HybridRow[]> {
  const db = openDb(scopeDir);
  try {
    const pool = Math.max(limit * 4, 25); // re-rank room
    const cands = new Map<string, Candidate>();

    // 1. lexical
    const safe = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replaceAll('"', "")}"`)
      .join(" OR ");
    if (safe) {
      const lex = db
        .prepare(`SELECT card_id, bm25(search) AS bm25 FROM search WHERE search MATCH ? ORDER BY bm25(search) LIMIT ?`)
        .all(safe, pool) as { card_id: string; bm25: number }[];
      for (const r of lex) cands.set(r.card_id, { cardId: r.card_id, bm25: r.bm25 });
    }

    // 2. semantic (skipped silently if no embedder or no stored vectors).
    // A model-backed embedder can fail to load (e.g. minilm selected but the
    // optional @huggingface/transformers dep isn't installed) — degrade to
    // lexical-only rather than crash the whole search.
    if (embedder) {
      const rows = db.prepare(`SELECT card_id, vec FROM vectors WHERE embedder_id = ?`).all(embedder.id) as {
        card_id: string;
        vec: Buffer;
      }[];
      if (rows.length) {
        try {
          const q = await embedder.embed(query);
          const sims = rows
            .map((r) => ({ cardId: r.card_id, sim: cosine(q, blobToVector(r.vec)) }))
            .sort((a, b) => b.sim - a.sim)
            .slice(0, pool);
          for (const s of sims) {
            const existing = cands.get(s.cardId);
            if (existing) existing.vectorSim = s.sim;
            else cands.set(s.cardId, { cardId: s.cardId, vectorSim: s.sim });
          }
        } catch {
          /* embed failed (model unavailable) → lexical-only, never crash */
        }
      }
    }

    // drop dedup-hidden cards before fusion (still reachable by id elsewhere)
    for (const id of loadHidden(scopeDir)) cands.delete(id);

    const fused: ScoredCard[] = fuse([...cands.values()], undefined, limit);
    if (!fused.length) return [];

    // 3. hydrate to IndexRows, preserving fused order
    const place = fused.map((_, i) => `?`).join(",");
    const ids = fused.map((f) => f.cardId);
    const meta = db
      .prepare(
        `SELECT card_id, session_id, project, date, outcome, intent, title, size_kb, has_card
         FROM sessions WHERE card_id IN (${place})`,
      )
      .all(...ids) as IndexRow[];
    const byId = new Map(meta.map((m) => [m.card_id, m]));
    return fused
      .map((f): HybridRow | undefined => {
        const m = byId.get(f.cardId);
        return m ? { ...m, score: f.score, why: f.why } : undefined;
      })
      .filter((r): r is HybridRow => !!r);
  } finally {
    db.close();
  }
}

function defaultEmbedderOrNull(): Embedder | undefined {
  try {
    return defaultEmbedder();
  } catch {
    return undefined;
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
