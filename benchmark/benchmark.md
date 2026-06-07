# links — Phase 0 retrieval benchmark

> Mined from real history (`inventory.tsv`, 83 substantive sessions) on 2026-06-07.
> **Purpose:** the product metric. A question "passes" when a fresh agent with links
> reaches the correct answer in fewer tokens than one without it.

## Measurement protocol (the exit criterion, operationalized)

For each question, run twice with a fresh agent in the relevant project directory:
- **A (baseline):** no links. Agent investigates from scratch (code, files, web).
- **B (links):** tier-0 injection + MCP tools available.

Record per run: `tokens_to_correct_answer` (input+output until the answer is verifiably
correct), `wall_seconds`, `answer_correct (y/n)`, and for B: `tiers_used` (0/1/2/3),
`sessions_read`, `msgs_range_read`.

**Pass:** B correct AND `B.tokens < A.tokens`. **Phase 1 exit:** ≥7/10 held-out pass,
0/5 negative false-positives (links returns "nothing relevant" rather than a wrong card).

Tune extraction prompts against TUNING questions only. Score on HELD-OUT. Never edit a
card by hand to make a question pass — fix the extractor and re-run.

## Tuning set (10)

| # | Question a future agent would ask | Ground-truth session(s) | Project |
|---|---|---|---|
| T1 | How did we fix the wix-deepdive MCP -32000 connection error? What was the root cause? | `520b8330`, `51d5fe29` | Personal |
| T2 | What happens end-to-end when a Vagaro URL is pasted into glow-up and Continue is clicked? | `a533a625` | glow-up |
| T3 | Why were services not imported for a generated glow-up site (ofear123 / desert-beauty-salo-2 case)? | `c4719074` | glow-up |
| T4 | What was the Harmony site-publish bug — draft written but cloned site not published — and where did we leave it? | `d6c38df4`, `f627586c`, `c54c9f50` | glow-up |
| T5 | Where is the reference code for sending SMS via Twilio that we used? | `d477e3df` | glow-up |
| T6 | How did we fix the GlobalProtect VPN that stopped connecting (custom script)? | `9cea4cb0`, `95780f7f` | system |
| T7 | Can the roundtable MCP be converted to a skill? What did we conclude and how? | `7f3c98e1`, `cb4b1006` | roundtable-mcp / projectX |
| T8 | Why did the old API allow 52 but the new one limits to 12 (bookings, deepdive req 1780254318…)? | `e3f1b2ee` | Wix |
| T9 | How did we identify which process was writing to the HDD/SSD? | `41560a5d`, `8880a2bf` | system |
| T10 | What part of glow-up changes the text in the generated site? | `f8ed78b1` | glow-up |

## Held-out set (10) — do not tune against these

| # | Question | Ground-truth session(s) | Project |
|---|---|---|---|
| H1 | Why did Cursor still open the old version after installing via App Center, and what fixed it? | `ae9db516` | system |
| H2 | How does the glow-up E2E flow work, step by step (X → Y → Z)? | `0916f8f8` | glow-up |
| H3 | What did we find when investigating the failed order creation (deepdive req 1779017235…)? | `d3f572d1` (outcome: partial — ended mid-verification on authorization-policy propagation; card must say so) | Wix |
| H4 | What is the purpose/intent/current state of the glow-up project (the brief we wrote for the two joining developers)? | `2813ae6a`, `8bf5355a` | glow-up |
| H5 | Do we have real scraper code for each platform (Mindbody, Vagaro, Square, Boulevard, Booksy)? | `7bf4b078` | glow-up |
| H6 | How did we upgrade the NVIDIA drivers, and were there any gotchas? | `e91f8acf` | system |
| H7 | How was the number of displayed templates made configurable in the glow-up template view? | `2807545a` | glow-up |
| H8 | What did the dinoMaker webapp do and how was the camera→dino image flow built? | `7eb4f3c3` | dinoMaker |
| H9 | What was wrong when the Slack desktop app wouldn't open, and what fixed it? | `c2284b30` | system |
| H10 | Why did the wix-deepdive MCP expose only 17 tools when we expected more? | `2de735a0` | projectX |

## Negative set (5) — correct answer is "nothing relevant in history"

> Verified by grep on 2026-06-07: N1–N5 have no answering session. (Original N1
> "yarn→pnpm migration" was replaced — "pnpm" had 3 incidental glow-up mentions.)
> Incidental keyword mentions elsewhere (e.g. "kubernetes" in passing) are kept
> deliberately — retrieval must not surface a card on a stray keyword.

### ⚠ Corpus-hygiene rule (verified necessary)

Sessions in which links itself was designed/built (`51d5fe29` and all future links
work sessions) **must be excluded from the benchmark scoring corpus** — they contain
these questions verbatim, leaking held-out items and contaminating negatives. They
may still be carded for production use, just never scored against.

| # | Question | Why plausible |
|---|---|---|
| N1 | How did we set up Terraform for glow-up infrastructure? | infra work plausible; "terraform" = 0 hits in corpus (verified 2026-06-07) |
| N2 | What did we decide about Redis caching in booking-checkout-owner? | checkout sessions exist; Redis was never discussed |
| N3 | How did we fix the failing Docker build in roundtable-mcp? | repo exists; no Docker work |
| N4 | Which session set up Kubernetes ingress for the links project? | links is brand new; no infra |
| N5 | How did we configure Playwright visual-regression snapshots in dinoMaker? | dinoMaker exists; no VR testing |

## Notes from mining (feed into Phase 1)

1. **93% of raw sessions were claude-mem observer transcripts** (1,074/1,157) — synthetic
   re-narrations. The adapter MUST exclude `-home-ofirh--claude-mem-observer-sessions`
   (and `*/subagents/*`). Real corpus: **83 sessions, 159MB ≈ ~42M tokens** → full
   backfill ≈ **$21** (Haiku, Batch API).
2. Handoff-brief sessions (`f627586c`, `c54c9f50`, `f5997106`, `cc689188`) are *manual*
   versions of what links automates — they chain explicitly ("continued, builds on the
   previous brief") → free ground truth for `supersedes`/`relates-to` edges.
3. `f12390a9` literally asks "Are you actively aware of all the sessions that we opened
   for this project?" — the main goal, asked verbatim, 81 turns, 8.4MB. Chunked
   extraction test case + the product's reason to exist in one file.
4. Repeated "# Daily Slack Behavior Review" sessions (~6) are near-identical scheduled
   runs — a card-dedup/series problem for v2; triviality gate should collapse them.
5. Phase 1 corpus = all ground-truth sessions above (~30) + the remaining real sessions
   as distractors → card all 83. At this size, "benchmark-driven corpus" = whole corpus.
