/**
 * Hybrid retrieval — fuse lexical (FTS5/BM25) with semantic (vector) signals,
 * basic-memory style, and explain WHY each card matched.
 *
 * WHY hybrid: pure FTS5 (lexical) misses paraphrase queries — "speed up the
 * build" won't match a card that says "reduce webpack compile time". The field
 * (claude-mem v13, mem0, basic-memory) moved to semantic+lexical fusion; we
 * close that gap here while keeping the result EXPLAINABLE (no surveyed tool
 * tells the agent which signal fired — we do).
 *
 * EMBEDDING CHOICE (see report / DESIGN.md): the embedding SOURCE is pluggable
 * behind `Embedder` (mirrors the codex extraction seam in config.ts/extractor.ts).
 * The DEFAULT embedder is a zero-dependency, fully-local hashed character-n-gram
 * vectorizer: no model download, no cloud key, no native build, works on a
 * solo-maintained TS tool the moment it's cloned. It captures sub-word overlap
 * (morphology, shared roots, partial paraphrase) that token-level BM25 cannot,
 * which is exactly the class of miss FTS5 has. A higher-fidelity sentence-model
 * embedder (e.g. a local MiniLM via onnxruntime, or a cheap embeddings API)
 * drops in by implementing `Embedder` — the fusion + explainability below are
 * embedder-agnostic. We store vectors as BLOBs in sqlite (no sqlite-vec
 * dependency) and brute-force cosine; at links' corpus scale (tens–low
 * thousands of cards) brute force is sub-millisecond, so the vector *index* is
 * a non-issue — the vector *signal* is the point.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

// ---------- embedder seam ----------

export interface Embedder {
  /** Stable id stamped alongside stored vectors so a model change forces a rebuild. */
  readonly id: string;
  readonly dim: number;
  /** Async so a model-backed embedder (onnxruntime) fits the same seam as the
   *  synchronous hash one — callers await regardless of which is configured. */
  embed(text: string): Promise<Float32Array>;
}

const DEFAULT_DIM = 256;

/**
 * Zero-dependency local embedder: feature-hashing over character 3/4/5-grams
 * plus whitespace tokens, signed-hash trick to reduce collision bias, L2
 * normalized. Deterministic and offline. Not as strong as a trained sentence
 * model, but it generalizes past exact tokens (the FTS5 failure mode) and needs
 * nothing installed.
 */
export class HashEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  constructor(dim = DEFAULT_DIM) {
    this.dim = dim;
    this.id = `hash-ngram-v1-d${dim}`;
  }
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!norm) return v;
    const add = (feature: string) => {
      const h = fnv1a(feature);
      const idx = h % this.dim;
      const sign = (h >>> 31) & 1 ? -1 : 1; // signed-hash: cancels some collision bias
      v[idx]! += sign;
    };
    // whitespace tokens (carry exact-term signal so semantic ≥ lexical on exact hits)
    const tokens = norm.split(" ").filter(Boolean);
    for (const t of tokens) add(`w:${t}`);
    // character n-grams over the token stream (sub-word / paraphrase signal)
    const padded = ` ${tokens.join(" ")} `;
    for (let n = 3; n <= 5; n++) {
      for (let i = 0; i + n <= padded.length; i++) add(`g${n}:${padded.slice(i, i + n)}`);
    }
    return l2normalize(v);
  }
}

/**
 * Real sentence-model embedder: all-MiniLM-L6-v2 (384-d) via Transformers.js,
 * fully local + keyless. The model (~25 MB) downloads once to ~/.links/models on
 * first use, then runs offline. The heavy onnxruntime dependency is loaded via a
 * LAZY dynamic import, so a hash-only install never pays for it. Output is
 * mean-pooled + L2-normalized to match cosine() / the HashEmbedder contract.
 */
export class MiniLMEmbedder implements Embedder {
  readonly id = "minilm-l6-v2-d384";
  readonly dim = 384;
  private extractor: ((text: string, opts: object) => Promise<{ data: ArrayLike<number> }>) | undefined;
  private ready: Promise<void> | undefined;
  private async load(): Promise<void> {
    let mod: typeof import("@huggingface/transformers");
    try {
      mod = await import("@huggingface/transformers");
    } catch {
      throw new Error(
        'embedder "minilm" needs the optional dependency — run `npm install @huggingface/transformers` (or set "embedder":"hash" in ~/.links/config.json).',
      );
    }
    mod.env.cacheDir = join(homedir(), ".links", "models"); // keep the model inside the tool's own dir
    // q8-quantized weights: ~23MB vs ~87MB fp32, negligible recall loss for retrieval.
    this.extractor = (await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" })) as never;
  }
  async embed(text: string): Promise<Float32Array> {
    const norm = text?.trim();
    if (!norm) return new Float32Array(this.dim); // empty → zero vec (cosine 0), matches HashEmbedder
    this.ready ??= this.load();
    await this.ready;
    const out = await this.extractor!(norm, { pooling: "mean", normalize: true });
    return new Float32Array(out.data); // copy out of the tensor view; already L2-normalized
  }
}

let _default: Embedder | undefined;
export function defaultEmbedder(): Embedder {
  if (_default) return _default;
  _default = config().embedder === "minilm" ? new MiniLMEmbedder() : new HashEmbedder();
  return _default;
}

/** Test/CLI seam: drop the cached default so a config change takes effect. */
export function resetEmbedderCache(): void {
  _default = undefined;
}

// ---------- vector math ----------

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return v;
}

/** Cosine similarity of two L2-normalized vectors == dot product. Returns 0..1-ish
 * (signed embedder can dip slightly negative; callers clamp). */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVector(b: Buffer | Uint8Array): Float32Array {
  // copy into an aligned ArrayBuffer (sqlite blobs aren't guaranteed 4-byte aligned)
  const copy = Buffer.from(b);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

// ---------- fusion ----------

/** One candidate entering fusion, with whatever signals were computed for it. */
export interface Candidate {
  cardId: string;
  /** Raw FTS5 bm25() value (lower = better; negative). undefined if not a lexical hit. */
  bm25?: number;
  /** Cosine similarity to the query vector. undefined if no vector / no embedder. */
  vectorSim?: number;
}

export interface ScoredCard {
  cardId: string;
  /** Fused score in [0,1] — higher is better. */
  score: number;
  /** Normalized per-signal contributions (each 0..1) before weighting. */
  lexical: number | null;
  semantic: number | null;
  /** Human-readable WHY: which signals fired and how strongly. */
  why: string;
}

export interface FusionWeights {
  lexical: number;
  semantic: number;
}
// Lexical slightly favored: BM25 on an exact term hit is high-precision; the
// semantic signal is there to RESCUE paraphrase misses, not to overrule a clean
// keyword match. Tunable; surfaced so the benchmark can sweep it.
export const DEFAULT_WEIGHTS: FusionWeights = { lexical: 0.6, semantic: 0.4 };

/**
 * Min-max normalize bm25 across the candidate set. bm25() is negative and
 * unbounded, so an absolute threshold is meaningless — only the RANKING within
 * this query's candidates is. Best (most-negative) bm25 → 1.0; the worst maps
 * to LEX_FLOOR, not 0 — a real keyword hit, even the weakest, must keep a
 * non-zero lexical contribution (else it would be indistinguishable from a card
 * with no lexical match at all, and could be dropped). Single candidate → 1.0.
 */
const LEX_FLOOR = 0.1;
function normalizeBm25(cands: Candidate[]): Map<string, number> {
  const out = new Map<string, number>();
  const vals = cands.filter((c) => c.bm25 !== undefined).map((c) => c.bm25!);
  if (!vals.length) return out;
  const min = Math.min(...vals); // most relevant (bm25 is negative)
  const max = Math.max(...vals); // least relevant
  const span = max - min;
  for (const c of cands) {
    if (c.bm25 === undefined) continue;
    const unit = span === 0 ? 1 : (max - c.bm25) / span; // 0..1
    out.set(c.cardId, LEX_FLOOR + (1 - LEX_FLOOR) * unit);
  }
  return out;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Fuse lexical + semantic into a single ranked list with explanations.
 * A card that hits EITHER signal is a candidate (semantic rescue of paraphrase
 * misses is the whole point) — so we union, not intersect.
 */
export function fuse(
  cands: Candidate[],
  weights: FusionWeights = DEFAULT_WEIGHTS,
  limit = 10,
): ScoredCard[] {
  const lexNorm = normalizeBm25(cands);
  // Which signal CLASSES exist at all in this candidate set. If a whole class is
  // absent (e.g. embeddings unavailable → no semantic anywhere), drop its weight
  // from the denominator so the remaining signal still spans [0,1] (graceful
  // degradation to FTS5-only ranking). When BOTH classes are present, the
  // denominator is the FULL weight: a card hitting only ONE signal is penalized
  // for missing the other — corroboration by two signals should beat one. This
  // is what makes a dual-signal hit outrank a single strong hit (hybrid intent).
  const anyLex = cands.some((c) => c.bm25 !== undefined);
  const anySem = cands.some((c) => c.vectorSim !== undefined);
  const den = (anyLex ? weights.lexical : 0) + (anySem ? weights.semantic : 0);

  const scored: ScoredCard[] = cands.map((c) => {
    const lex = lexNorm.has(c.cardId) ? lexNorm.get(c.cardId)! : null;
    const sem =
      c.vectorSim === undefined ? null : Math.max(0, Math.min(1, c.vectorSim));
    let num = 0;
    if (lex !== null) num += weights.lexical * lex;
    if (sem !== null) num += weights.semantic * sem;
    const score = den > 0 ? num / den : 0;

    const parts: string[] = [];
    if (lex !== null && sem !== null) {
      parts.push(`lexical+semantic (BM25 ${pct(lex)}, vector ${pct(sem)})`);
    } else if (lex !== null) {
      parts.push(`lexical only (BM25 ${pct(lex)}; no semantic signal)`);
    } else if (sem !== null) {
      parts.push(`semantic only (vector ${pct(sem)}) — paraphrase match, not a keyword hit`);
    } else {
      parts.push("no signal");
    }
    return { cardId: c.cardId, score, lexical: lex, semantic: sem, why: parts.join(" ") };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
