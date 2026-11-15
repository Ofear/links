/** Run: npx tsx src/retrieval.test.ts — exits non-zero on any failure.
 * Covers the fusion ranking, explainability output, and embedder behaviour. */
import {
  blobToVector,
  cosine,
  type Candidate,
  DEFAULT_WEIGHTS,
  fuse,
  HashEmbedder,
  vectorToBlob,
} from "./retrieval.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}${detail ? ` → ${detail}` : ""}`);
    failed++;
  }
}

// ---------- embedder ----------
// Pin the HashEmbedder directly: deterministic + offline, independent of which
// embedder this machine's config selects (minilm would need a model download).
const emb = new HashEmbedder();
{
  const v = await emb.embed("reduce webpack compile time");
  let s = 0;
  for (const x of v) s += x * x;
  check("embedder vectors are L2-normalized", Math.abs(s - 1) < 1e-5);
}

{
  const a = await emb.embed("npm authToken 401");
  check("identical text → cosine ≈ 1", Math.abs(cosine(a, a) - 1) < 1e-6);
}

{
  const z = await emb.embed("");
  const x = await emb.embed("anything");
  check("empty text → zero vector → cosine 0 (no crash)", cosine(z, x) === 0);
}

// paraphrase / shared-root: more similar than unrelated text
const base = await emb.embed("speed up the slow build compilation");
const para = await emb.embed("the compile build is slow, make compilation faster");
const unrel = await emb.embed("redact phone numbers from transcripts");
check(
  "paraphrase scores higher than unrelated",
  cosine(base, para) > cosine(base, unrel),
  `para=${cosine(base, para).toFixed(3)} unrel=${cosine(base, unrel).toFixed(3)}`,
);

// blob round-trip
{
  const v = await emb.embed("round trip test");
  const back = blobToVector(vectorToBlob(v));
  check("vector survives blob round-trip", back.length === v.length && Math.abs(cosine(v, back) - 1) < 1e-6);
}

// ---------- fusion ranking ----------

// 1. Lexical-only query (no vectors): ranking follows BM25 (more-negative = better).
{
  const cands: Candidate[] = [
    { cardId: "A", bm25: -5 }, // best
    { cardId: "B", bm25: -1 }, // worst
    { cardId: "C", bm25: -3 },
  ];
  const r = fuse(cands, DEFAULT_WEIGHTS, 10);
  check("lexical-only: best BM25 ranks first", r[0]?.cardId === "A", r.map((x) => x.cardId).join(","));
  check("lexical-only: worst BM25 ranks last", r[r.length - 1]?.cardId === "B");
  check("lexical-only: explanation says 'lexical only'", r[0]!.why.includes("lexical only"));
  check("lexical-only: semantic contribution is null", r[0]!.semantic === null);
}

// 2. Semantic rescue: a paraphrase-only hit (no BM25 row) still surfaces.
{
  const cands: Candidate[] = [
    { cardId: "lex", bm25: -2 }, // keyword hit, mediocre semantic
    { cardId: "sem", vectorSim: 0.95 }, // NO keyword hit, strong semantic — must appear
  ];
  const r = fuse(cands, DEFAULT_WEIGHTS, 10);
  check("semantic rescue: paraphrase-only card is in results", r.some((x) => x.cardId === "sem"));
  const sem = r.find((x) => x.cardId === "sem")!;
  check("semantic rescue: explanation flags semantic-only", sem.why.includes("semantic only"));
  check("semantic rescue: lexical contribution is null for it", sem.lexical === null);
}

// 3. Fusion blend: corroboration wins — a card that is the BEST lexical hit AND
//    has a strong semantic signal beats a card that only ties it on lexical.
//    (With both signal classes present, missing a signal contributes 0, so two
//    decent signals outrank one strong one.)
{
  const cands: Candidate[] = [
    { cardId: "both", bm25: -5, vectorSim: 0.8 }, // best BM25 + strong semantic
    { cardId: "lexOnly", bm25: -5 }, // ties on BM25 but no semantic
    { cardId: "semOnly", vectorSim: 0.6 },
  ];
  const r = fuse(cands, DEFAULT_WEIGHTS, 10);
  check(
    "fusion: corroborated (dual-signal) card ranks first",
    r[0]?.cardId === "both",
    r.map((x) => `${x.cardId}:${x.score.toFixed(2)}`).join(" "),
  );
  check("fusion: dual-signal explanation lists both signals", r[0]!.why.includes("lexical+semantic"));
  const lexOnly = r.find((x) => x.cardId === "lexOnly")!;
  check("fusion: same-lexical card without semantic ranks below the corroborated one", r[0]!.score > lexOnly.score);
}

// 4. Score bounds + explainability shape: every result is in [0,1] with a non-empty why
//    and at least one non-null signal.
{
  const cands: Candidate[] = [
    { cardId: "A", bm25: -4, vectorSim: 0.5 },
    { cardId: "B", bm25: -1 },
    { cardId: "C", vectorSim: 0.9 },
  ];
  const r = fuse(cands, DEFAULT_WEIGHTS, 10);
  check(
    "all scores in [0,1]",
    r.every((x) => x.score >= 0 && x.score <= 1),
    r.map((x) => x.score).join(","),
  );
  check("every result explains itself", r.every((x) => x.why.length > 0 && (x.lexical !== null || x.semantic !== null)));
}

// 5. Weight sensitivity: cranking semantic weight promotes the semantic-strong card.
{
  const cands: Candidate[] = [
    { cardId: "lexStrong", bm25: -5, vectorSim: 0.1 },
    { cardId: "semStrong", bm25: -1, vectorSim: 0.95 },
  ];
  const lexFav = fuse(cands, { lexical: 0.9, semantic: 0.1 }, 10);
  const semFav = fuse(cands, { lexical: 0.1, semantic: 0.9 }, 10);
  check("weights: lexical-heavy → lexStrong first", lexFav[0]?.cardId === "lexStrong");
  check("weights: semantic-heavy → semStrong first", semFav[0]?.cardId === "semStrong");
}

// 6. Degradation: empty candidate set → empty result, no throw.
check("empty candidates → empty result", fuse([], DEFAULT_WEIGHTS, 10).length === 0);

// 7. Custom embedder dim is honored (seam works).
check("HashEmbedder honors custom dim", new HashEmbedder(64).dim === 64 && (await new HashEmbedder(64).embed("x")).length === 64);

// ---------- loadSuperseded (db.ts) ----------
// Cards with a non-empty supersededBy are excluded from default search; missing
// or malformed links.json degrades to an empty set (never throws).
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadSuperseded } = await import("./db.js");

  const dir = mkdtempSync(join(tmpdir(), "links-superseded-"));
  try {
    // no links.json yet → empty set
    check("loadSuperseded: missing links.json → empty set", loadSuperseded(dir).size === 0);

    writeFileSync(
      join(dir, "links.json"),
      JSON.stringify({
        old: { relatesTo: [], supersedes: [], supersededBy: ["new"] }, // superseded → excluded
        new: { relatesTo: [], supersedes: ["old"], supersededBy: [] }, // the winner → kept
        lone: { relatesTo: ["x"], supersedes: [], supersededBy: [] }, // unrelated → kept
      }),
    );
    const ids = loadSuperseded(dir);
    check("loadSuperseded: non-empty supersededBy is excluded", ids.has("old"));
    check("loadSuperseded: superseding/winner card is kept", !ids.has("new"));
    check("loadSuperseded: card with empty supersededBy is kept", !ids.has("lone") && ids.size === 1);

    // malformed json → empty set, no throw
    writeFileSync(join(dir, "links.json"), "{ not json");
    check("loadSuperseded: malformed links.json → empty set (no throw)", loadSuperseded(dir).size === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
