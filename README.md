# links

**Cross-tool session memory for coding agents.** An agent should reuse past work instead
of re-investigating — and remember what you already told it.

links indexes your real AI-coding sessions (Claude Code, Codex CLI; Cursor planned) into
three memory layers, served to every tool over MCP and pushed into context at session
start:

| Layer | Answers | How |
|---|---|---|
| **Episodic** | "did we already solve this?" | per-session metadata cards with evidence pointers `[msgs N–M]` → read only the relevant transcript slice |
| **Pinned notes** | "what must every session know?" | `pin_note` MCP tool → injected every session |
| **Rules** | "what did the user already tell me?" | auto-harvested standing instructions → injected every session, never re-explained |

## How it works

```
raw transcripts (immutable, owned by the tools — never copied)
  → adapters (claude-code, codex)        normalized sessions, stable msg indices
  → triviality gate                       junk/tiny sessions get no card
  → secret scanner                        deterministic, pre+post extraction
  → extractor (codex headless, chunked)   schema-forced cards w/ evidence pointers
  → linker                                high-precision relates-to / supersedes edges
  → store/<scope>/                        markdown cards + sqlite FTS5, per privacy scope
  → MCP servers + SessionStart injection  search / get_card / read_session / expand_links / pin_note
```

Everything below the first line is **derived and rebuildable** — bad extraction is
re-extractable, the store is disposable, your transcripts never move.

## Commands

```sh
npm run ingest                 # scan all tools' session stores → tier-1 index
npx tsx src/cli.ts extract --all   # card new sessions (codex headless, --ephemeral)
npx tsx src/cli.ts link        # compute graph edges + dedup plan, re-render cards
npx tsx src/cli.ts index       # rebuild FTS5 index + semantic vectors
npx tsx src/cli.ts rules       # harvest standing rules → rules/<project>.md
npx tsx src/cli.ts inject CWD  # tier-0 context block (used by SessionStart hook)
npx tsx src/bench.ts [set] [--lexical|--fixture|--no-judge]   # retrieval benchmark
npx tsx src/server.ts SCOPE    # MCP server (personal|wix)
npx links init                 # detect tools, write links.config.json, print MCP/hook setup
```

Retrieval is **hybrid** (FTS5/BM25 + semantic vectors, fused and explainable) with a
**freshness layer**: every card is validated against current code (git-SHA diff, mtime
fallback) and stale/broken cards are flagged — never silently injected. Near-duplicate
cards are consolidated conservatively (`link` writes `consolidation.json`).

## Design

See `DESIGN.md` (architecture, risks, phases) and `benchmark/benchmark.md` (the
25-question retrieval benchmark that gates every quality claim). The product metric:
tokens-to-correct-answer **with** links vs **without**.

Status: personal + wix corpora carded; Phase-1 gate **passing** on the free retrieval
metric (held-out 10/10, 0 negative false positives, ~245× fewer tokens-to-answer).
Open: hybrid currently ≈ lexical (R@5 85%) because the default embedder is a zero-dep
hash-n-gram placeholder — a real sentence-embedding model behind the `Embedder` seam is
the next lift; the full codex-judge benchmark run is also pending. Machine-specific paths
now live in `links.config.json` defaults (`npx links init` for any machine).
