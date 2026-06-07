# links — cross-tool linked-data session memory

> **Design v3** · 2026-06-07 · survived one web-research pass (104-agent verified survey) + two adversarial evaluations

## ⭐ Main goal (judge everything against this)

**An agent should reuse past work instead of re-investigating — and remember what the
user already told it.** (Expanded by user, 2026-06-07.) Three memory layers:

| Layer | Question it answers | Surface |
|---|---|---|
| **Episodic** — session cards | "did we already solve this?" | search → card → slice (pull) + recent-sessions injection |
| **Pinned notes** — sticky facts | "what must every session know?" | `pin_note` MCP tool → notes/<project>.md → always injected |
| **Rules** — standing instructions | "what did the user already tell me, so they NEVER re-explain?" | auto-harvested from cards' rules sections → rules/<project>.md (PINNED section is hand-editable, never regenerated) → always injected |

Rules and notes are PUSH-only (in front of the agent's eyes every session); episodic is
push for recency + pull for depth.

Measured concretely: given a task whose answer exists in past session history, an agent with links reaches the correct answer in **fewer tokens and less time** than an agent without it. Not "the index is complete," not "the graph is elegant" — *did the agent look ahead, find the prior work, and use it.*

Corollaries that gate every design decision:
1. **Push beats pull.** Memory that waits to be queried doesn't get used. The tier-0 injection (index lines pushed into context at session start) is the highest-leverage component, not an afterthought.
2. **Cheap to consult.** An agent must be able to decide "is this session relevant?" in ~300 tokens (card) and read only the relevant slice (~evidence pointers), never the whole transcript.
3. **Trustworthy.** A wrong card or wrong supersedes-edge that misleads an agent is worse than no memory. Precision over coverage everywhere.

## Core invariant

**Raw transcripts are immutable ground truth owned by the tools; everything links produces is derived, versioned, and rebuildable.** Bad extraction → re-extract. Broken adapter → backfill later. Wrong schema → regenerate. Every failure is recoverable.

## Verified corpus (2026-06-07, this machine)

| Source | Location (verified) | Volume |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (excl. `*/subagents/*` AND `-home-ofirh--claude-mem-observer-sessions` — **93% of raw files are synthetic claude-mem observer transcripts**, discovered in Phase 0 mining) | **83 real sessions, 159MB ≈ ~42M tokens** (raw incl. synthetic: 1,158 / 368MB); max session ~5M tok |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — **NOT** `history.jsonl` (prompts only, 54 lines) | 14MB |
| Cursor | `~/.cursor/chats/<ws>/<id>/store.db` — sqlite, opaque `blobs`+`meta` tables | 27MB, stale (March) |
| claude-mem (bootstrap import) | `~/.claude-mem/claude-mem.db` — sqlite FTS5, no graph tables | 7,523 observations |

**Honest framing:** ~96% of current data is Claude Code. v1 is effectively *a better claude-mem for Claude Code* (session-granularity cards, evidence pointers, graph edges, owned schema); cross-tool is option value. Day-one win must come from Claude Code retrieval quality.

## Architecture

```
┌──────────────────── SOURCES (read-only, never copied) ───────────────────────────┐
│ ~/.claude/projects/**/*.jsonl  ·  ~/.codex/sessions/**/rollout-*.jsonl           │
│ ~/.cursor/chats/**/store.db (Phase 4)  ·  ~/.claude-mem/claude-mem.db (import)   │
└────────────┬──────────────────────────────────────────────────────────────────────┘
             ▼
  ADAPTERS (one per tool, narrow contract)
    emit Session{id, tool, cwd, started/ended, messages[] (stable global indices),
    tool_calls[], model, git{repo,branch,head}}
    fail LOUD (unparseable → stub in index) · fixture snapshot tests · version sniffing
             ▼
  TRIVIALITY GATE — < N user turns or < X KB → index line only, no card, no LLM call
             ▼
  SECRET SCANNER — deterministic (gitleaks-style regex + entropy), BEFORE and AFTER
    extraction; LLM redaction is a supplement, never the mechanism
             ▼
  EXTRACTOR (chunked map-reduce — load-bearing, Phase 1)
    ≤150k tok: single pass (Haiku 4.5, schema-forced JSON)
    >150k tok: chunk → partial cards → merge, preserving global message indices
    every claim carries evidence ptr [msgs N–M] · stamped extractor_version
    backfill via Batch API (~$21 one-time on Haiku for the real 42M-tok corpus)
             ▼
  LINKER (v1: high-precision auto-edges ONLY)
    relates-to  ← shared files / project / entities
    supersedes  ← same files + same issue + later date + explicit signal
    rich semantic edges (follows-up, same-bug-as) = v2; a wrong supersedes edge
    is worse than no edge
             ▼
  CARD STORE
    Markdown + YAML frontmatter + [[wikilinks]] (basic-memory-compatible syntax)
    PHYSICAL scope partition: ~/links/personal/  ~/links/wix/  (from session cwd)
    per-scope sqlite: FTS5 + links table (sqlite-vec only if benchmark shows misses)
    cards = disposable cache, re-extractable forever
             ▼
  SERVING — two surfaces, push and pull
    TIER-0 INJECTION (push — the component that makes it get used):
      SessionStart hook (Claude Code) / rules file (Cursor) / AGENTS.md (Codex)
      injects ~10 most relevant index lines for the current project + MCP pointer
    MCP SERVER (pull — one binary, one instance per scope):
      search(query, filters)        → tier-1 index lines        ~30 tok/hit
      get_card(id)                  → tier-2 card                ~300–500 tok
      expand_links(id, depth)       → graph neighborhood
      read_session(id, msg_range?)  → tier-3 raw slice via evidence ptrs
      contract in tool descriptions: never tier-3 without tier-2 first

  CAPTURE: batch indexer scans sources for new sessions (zero data loss, backfills
  history day one) → per-tool hooks later, freshness optimization only
```

## Card schema (tier 2)

```markdown
---
id: cc-2026-06-07-51d5fe29
tool: claude-code        scope: personal       project: Personal
session: ~/.claude/projects/.../51d5fe29….jsonl
date: 2026-06-07         outcome: succeeded | abandoned | superseded
extractor_version: 1
intent: fix wix-deepdive MCP -32000 connection error
git: {repo, branch, head}
tools_used: [Bash, Read, Edit, mcp:wix-deepdive]
files_touched: [~/.npmrc, ~/Projects/Personal/.npmrc]
---
## Summary
- Traced -32000 to project-level .npmrc overriding registry   [msgs 12–31]
- Fix: @wix:registry scope routing in ~/.npmrc                 [msgs 44–52]
## Decisions
- Scope-registry over removing override — keeps Personal on public npm  [msg 47]
## Issues flagged
- Plugin pinned 3 commits behind; lacks mcpServers config      [msgs 20–24]
## Links
- relates-to [[cc-2026-06-06-plugin-install]]
```

Evidence pointers are the biggest token win: `read_session(id, 44-52)` instead of a 170k-token full read.

## Risks → structural answers

| Risk | Handled by |
|---|---|
| Memory built but unused | tier-0 push injection (claude-mem proved the pattern in production) |
| Extraction quality | schema-forced output + evidence ptrs + versioned re-runs + held-out benchmark with negative questions |
| Giant sessions | chunked map-reduce with stable indices (mandatory: max session ≈ 5M tok) |
| Index pollution | triviality gate |
| Staleness | git SHA → query-time diff · conservative supersedes edges · volatility tags · rank by recency, never delete |
| Brittle adapters | narrow contract · loud failure stubs · batch indexer = backfill when fixed |
| Secret leakage | deterministic scanner pre+post extraction; cards travel, transcripts don't |
| Privacy scoping | physical partition (personal/ vs wix/) + per-scope MCP instance |
| Thin moat (claude-mem v13, very active) | cards derived & portable; durable assets = card corpus + benchmark; re-evaluate honestly if upstream ships session cards |
| Solo-maintainer rot | accepted consciously: ~few hours/month or it decays; design minimizes via batch indexer + loud failures + derived data |

## Build plan

### Phase 0 — Benchmark first ✅ DONE 2026-06-07
- `benchmark/inventory.tsv`: 83 real sessions mined (after excluding 1,074 synthetic observer transcripts — the mining itself caught this)
- `benchmark/benchmark.md`: 25 questions — 10 tuning / 10 held-out / 5 negative, each with ground-truth session IDs + measurement protocol (tokens-to-correct-answer, with vs without links; pass = ≥7/10 held-out, 0/5 negative false positives)
- Findings folded into Phase 1: adapter must exclude synthetic corpora; at 83 sessions, benchmark-driven corpus = whole corpus; manual handoff-brief chains = free supersedes-edge ground truth; scheduled-run near-duplicates = card-dedup problem for v2

### Phase 1 — Vertical slice (Claude Code only)
- Adapter → triviality gate → secret scanner → chunked extractor (Haiku 4.5)
- **Benchmark-driven corpus:** card the sessions containing each benchmark answer + ~50 distractors (NOT "50 recent" — held-out questions must be answerable in principle)
- Minimal MCP server (search / get_card / read_session) + tier-0 SessionStart injection
- Iterate extraction prompt on the tuning half; score on held-out
- **Exit criterion:** held-out questions answered cheaper than re-investigating; zero negative-question false positives

### Phase 2 — Graph + second tool (mostly DONE 2026-06-07, pulled forward)
- ✅ Linker: high-precision auto-edges (`relates-to` ≥2 shared files or ≥3 shared entities;
  `supersedes` only with explicit continuity signal) — 52 edges on first run
- ✅ Codex adapter over `~/.codex/sessions/**/rollout-*.jsonl` — 6 sessions ingested,
  including the literal Claude→Codex glow-up handoff session (`cx-` card prefix;
  card-id computation centralized in cards.ts)
- ✅ Cross-tool MCP serving: links-personal + links-wix registered in Claude Code
  (health-checked ✓), Codex config.toml, Cursor mcp.json — same store, all three tools
- Remaining: `expand_links` MCP tool, git-staleness signals, cross-tool benchmark questions

### Phase 3 — Backfill + freshness
- Full backfill via Batch API (~$50 Haiku) · claude-mem DB import
- SessionEnd hooks for freshness (batch indexer stays the backbone)
- Wix scope goes live + redaction hardening

### Phase 5 — Distribution (user decision 2026-06-07: links must be installable by anyone)
- `links.config.json`: scope rules (cwd-prefix → scope name), exclusion patterns, extraction
  engine (`codex` | `claude` | `api-key`), store dir — replaces every machine-specific constant
- `npx links init`: detect installed tools → write config → backfill → self-register MCP
  servers + SessionStart hook
- Publish to npm with `bin` entry; engine abstraction behind the existing `codexJson` seam
- Rule effective immediately: new code treats Ofir-machine specifics as config DEFAULTS,
  never constants. Currently hardcoded (to be lifted into config): observer-dir exclusion,
  Wix scope rule, Cursor-extension codex fallback, install paths in hook/MCP registration
- Sequencing: AFTER the benchmark proves value (don't package an unproven tool)

### Phase 4 — Optional leverage
- Cursor adapter (reverse-engineer store.db blobs — budgeted brittle, lowest value)
- sqlite-vec only if benchmark shows FTS5 misses
- Rich typed edges once supersedes precision proven
- Obsidian graph view (free via format compatibility)

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Platform | Scratch, small (~1–2k LOC); claude-mem = data source, not foundation | Card schema is the product; verified survey: nothing existing does cross-tool session cards |
| Card format | Own frontmatter + basic-memory wikilink syntax | Exit ramp + Obsidian free, no inherited constraints |
| Extraction model | Haiku 4.5 ($1/$5 per MTok), Batch API for backfill | Verified pricing; escalate per-session only if benchmark demands |
| Language | TypeScript | MCP SDK maturity, JSONL handling |
| Capture | Batch indexer first, hooks later | Tool-agnostic, crash-proof, backfills day one |

## Research record

- Landscape survey (2026-06-07, 22 sources, 25 claims adversarially verified): claude-mem = closest analog (3-layer progressive disclosure, Claude Code only, flat, per-prompt granularity); basic-memory = strongest cross-tool linked-data model (Markdown entities + wikilink relations + MCP everywhere); Cognee Cognify = text→graph extraction pattern; official MCP Memory server = minimal graph primitives. **No surveyed tool does cross-tool session ingestion + auto-extracted per-session cards + "tools used" facet.** Refuted: claude-mem cross-tool support (0-3), Mem0 memory-typing/90-day-expiry detail (1-2). Not evaluated (no surviving claims): Letta/MemGPT, Zep.
