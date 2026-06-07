/**
 * Validation / freshness layer — the leapfrog.
 *
 * Coding-memory's biggest open space: only GitHub Copilot Memory re-checks a
 * stored fact against current code before use, and it's locked to GitHub's
 * ecosystem. Everyone else silently injects stale facts. A wrong card that
 * misleads is worse than no memory (DESIGN.md goal #3, "Trustworthy").
 *
 * This layer is tool-agnostic, local, and zero-LLM. At inject/query time it
 * cheaply verifies a card against current reality using the metadata the card
 * already carries — git {repo,branch,head} SHA + files_touched — and produces a
 * per-card freshness VERDICT. The verdict DEMOTES or FLAGS a card; it NEVER
 * silently hides one. Surfacing a signal beats dropping a card without one.
 *
 * Design rules:
 *  - Graceful: no git repo, unreachable SHA, missing `git` binary → `unknown`,
 *    never a crash. Verdict degradation is the failure mode, not an exception.
 *  - Cheap: at most one `stat` per touched file + one `git diff --name-only`
 *    per (repo, SHA) pair. No object reads, no LLM. Results are computed live,
 *    never stored (stored freshness is itself stale — the bug we're fixing).
 *  - Honest about what it can prove: a `stale` verdict means "code changed since
 *    this card", NOT "this card is wrong". Decisions/rationale age far better
 *    than code state — the verdict's `reason` says exactly what changed so the
 *    agent can judge.
 *
 * INTEGRATION POINTS (this module owns the logic; callers add 1-2 lines each —
 * no edit to db.ts/server.ts/cli.ts is required to ship, these are the wiring):
 *
 *  1. server.ts → get_card (the highest-value hook). Today get_card appends
 *     liveStatusLine + stalenessLine (mtime-only). Replace/augment with the
 *     git-SHA-aware verdict — strictly stronger when a SHA exists:
 *         import { validateCard, freshnessBadge } from "./validate.js";
 *         const meta = JSON.parse(row.meta_json);              // already parsed nearby
 *         const v = await validateCard({ cwd: meta.cwd, gitCommit: meta.gitCommit,
 *           gitBranch: meta.gitBranch, filesTouched: meta.filesTouched, endedAt: meta.endedAt });
 *         // append freshnessBadge(v) to the returned card text (never drop the card).
 *
 *  2. server.ts → search. Annotate each index line with a compact verdict glyph
 *     so a stale/broken hit is visible BEFORE the agent spends a get_card:
 *         const v = await validateCard({ ...metaFields });     // cheap; diff cache shared
 *         line += v.freshness === "fresh" ? "" : ` [${v.freshness}]`;   // demote, don't hide
 *     (Demotion, not deletion — DESIGN.md: rank by recency, never delete.)
 *
 *  3. cli.ts → inject (tier-0 push). When listing recent sessions, suffix
 *     `[stale]`/`[broken]` on rows whose verdict isn't fresh, so the pushed
 *     context never silently asserts a stale fact at session start.
 *
 *  4. (optional) cli.ts → a `validate` subcommand for a corpus-wide health pass:
 *     loop the index through validateCard and print a verdict histogram — useful
 *     after a big refactor to see which cards the next refresh should re-extract.
 *
 * No new SessionMeta fields are needed: validateCard reads cwd, gitCommit,
 * gitBranch, filesTouched, endedAt — all already on SessionMeta (types.ts) and
 * already persisted in store/<scope>/index.jsonl + the db meta_json column.
 */
import { exec } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(exec);

/**
 * Per-card freshness verdict.
 *  - fresh:   no cited file changed since the card's SHA (or since the card if
 *             no SHA but files all still exist & predate nothing newer).
 *  - stale:   one or more cited files changed since the card's SHA / end time.
 *             The card may still be right — code MOVED, verify specifics.
 *  - broken:  a cited file is gone, or the repo/SHA the card references is
 *             unreachable. The card's implementation claims point at nothing.
 *  - unknown: no git context AND nothing checkable (no SHA, no files) — we have
 *             no cheap signal either way. Surfaced as such; never silently fresh.
 */
export type Freshness = "fresh" | "stale" | "broken" | "unknown";

export interface CardGitContext {
  /** Working dir the session ran in — used to locate the repo for `git diff`. */
  cwd?: string;
  /** Commit SHA recorded at session start (Codex records it; Claude Code does not). */
  gitCommit?: string;
  /** Branch name (informational; not used for diffing). */
  gitBranch?: string;
}

export interface CardValidationInput extends CardGitContext {
  /** Absolute file paths the session wrote (SessionMeta.filesTouched). */
  filesTouched: string[];
  /** ISO end time — fallback staleness signal when no SHA is available. */
  endedAt?: string;
}

export interface FreshnessVerdict {
  freshness: Freshness;
  /** One-line, agent-readable explanation of WHY — always present. */
  reason: string;
  /** Cited files that changed since the card's reference point. */
  changedFiles: string[];
  /** Cited files that no longer exist. */
  missingFiles: string[];
  /** How the verdict was reached — lets callers gauge confidence. */
  basis: "git-sha" | "mtime" | "existence" | "none";
}

/** Single-line badge for injecting into output. Empty when fully fresh & boring. */
export function freshnessBadge(v: FreshnessVerdict): string {
  switch (v.freshness) {
    case "fresh":
      return `✓ freshness: fresh — ${v.reason}`;
    case "stale":
      return `⚠ freshness: STALE — ${v.reason} Verify implementation specifics against current code; decisions/rationale age better than code state.`;
    case "broken":
      return `⛔ freshness: BROKEN — ${v.reason} Treat implementation details as unreliable; the cited code is no longer where the card says.`;
    case "unknown":
      return `· freshness: unknown — ${v.reason}`;
  }
}

/** git availability is probed once per process and cached. */
let gitOk: boolean | undefined;
async function hasGit(): Promise<boolean> {
  if (gitOk !== undefined) return gitOk;
  try {
    await execFile("git --version", { timeout: 3000 });
    gitOk = true;
  } catch {
    gitOk = false;
  }
  return gitOk;
}

/**
 * Cheap per-(repo,SHA) result: the set of paths changed between the card's SHA
 * and the repo's current HEAD. `null` => couldn't compute (not a repo, SHA not
 * present in history, detached/orphan, git missing) — caller degrades to mtime.
 * Cached per process: the same repo+SHA recurs across many cards in one inject.
 */
const diffCache = new Map<string, Set<string> | null>();

async function changedSinceSha(cwd: string, sha: string): Promise<Set<string> | null> {
  const key = `${cwd}\0${sha}`;
  const cached = diffCache.get(key);
  if (cached !== undefined) return cached;
  let result: Set<string> | null = null;
  if (await hasGit()) {
    try {
      // Verify the SHA is actually an ancestor reachable in this repo's history.
      // `cat-file -e <sha>^{commit}` fails (non-zero) if the object is absent —
      // e.g. the card came from a different clone, or history was rewritten.
      await execFile(`git -C ${shellQuote(cwd)} cat-file -e ${shellQuote(sha)}^{commit}`, {
        timeout: 5000,
      });
      // name-only diff: paths only, no content — the cheap question we care about.
      const { stdout } = await execFile(
        `git -C ${shellQuote(cwd)} diff --name-only ${shellQuote(sha)} HEAD`,
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      const repoRoot = await gitRoot(cwd);
      const set = new Set<string>();
      for (const line of stdout.split("\n")) {
        const rel = line.trim();
        if (rel && repoRoot) set.add(`${repoRoot}/${rel}`);
        else if (rel) set.add(rel);
      }
      result = set;
    } catch {
      result = null; // not a repo, SHA unknown, or diff failed — degrade gracefully
    }
  }
  diffCache.set(key, result);
  return result;
}

const rootCache = new Map<string, string | null>();
async function gitRoot(cwd: string): Promise<string | null> {
  const cached = rootCache.get(cwd);
  if (cached !== undefined) return cached;
  let root: string | null = null;
  try {
    const { stdout } = await execFile(`git -C ${shellQuote(cwd)} rev-parse --show-toplevel`, {
      timeout: 4000,
    });
    root = stdout.trim() || null;
  } catch {
    root = null;
  }
  rootCache.set(cwd, root);
  return root;
}

/** Minimal POSIX shell single-quote escaping for paths/SHAs passed to `exec`. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * THE entry point. Validate one card's metadata against current reality and
 * return a freshness verdict. Cheap, zero-LLM, graceful on every missing input.
 *
 * Strategy, best signal first:
 *  1. git SHA present + repo resolvable → diff cited files against SHA..HEAD.
 *     This is the strongest signal: "did the actual code these files name move
 *     since the card was true?" (the Copilot-Memory check, but tool-agnostic).
 *  2. no usable SHA but files cited → existence + mtime-vs-endedAt fallback.
 *  3. nothing checkable → `unknown`.
 *
 * Files gone always wins (`broken`) over `stale`: a card pointing at a deleted
 * file is more dangerous than one pointing at an edited file.
 */
export async function validateCard(input: CardValidationInput): Promise<FreshnessVerdict> {
  const files = input.filesTouched ?? [];

  // ---- Strategy 1: git SHA diff (strongest) ----
  if (input.gitCommit && input.cwd) {
    const changed = await changedSinceSha(input.cwd, input.gitCommit);
    if (changed === null) {
      // SHA recorded but repo/commit unreachable: the world the card references
      // is gone (different clone, rewritten history, repo deleted). broken — but
      // only if we can't fall through to a file-existence check below.
      const existence = await checkExistence(files);
      if (existence) return existence;
      return {
        freshness: "broken",
        reason: `recorded commit ${short(input.gitCommit)} is unreachable in ${input.cwd} (repo missing, different clone, or history rewritten).`,
        changedFiles: [],
        missingFiles: [],
        basis: "git-sha",
      };
    }
    // We have a real diff set. Intersect with the card's cited files.
    const missing: string[] = [];
    const changedCited: string[] = [];
    for (const f of files) {
      // file gone is checked independently of the diff (diff lists deletes too,
      // but a stat is the unambiguous proof the agent can't read it anymore)
      const present = await exists(f);
      if (!present) missing.push(f);
      else if (changed.has(f)) changedCited.push(f);
    }
    if (missing.length) {
      return {
        freshness: "broken",
        reason: `${missing.length}/${files.length} cited file(s) no longer exist (since ${short(input.gitCommit)}): ${sample(missing)}.`,
        changedFiles: changedCited,
        missingFiles: missing,
        basis: "git-sha",
      };
    }
    if (changedCited.length) {
      return {
        freshness: "stale",
        reason: `${changedCited.length}/${files.length} cited file(s) changed since ${short(input.gitCommit)}: ${sample(changedCited)}.`,
        changedFiles: changedCited,
        missingFiles: [],
        basis: "git-sha",
      };
    }
    // No cited files in the diff. If the card cited files, that's a strong fresh.
    return {
      freshness: "fresh",
      reason: files.length
        ? `none of the ${files.length} cited file(s) changed since ${short(input.gitCommit)}.`
        : `no files cited; commit ${short(input.gitCommit)} still reachable in repo.`,
      changedFiles: [],
      missingFiles: [],
      basis: "git-sha",
    };
  }

  // ---- Strategy 2: no SHA — existence + mtime-vs-endedAt fallback ----
  if (files.length) {
    const missing: string[] = [];
    const changedCited: string[] = [];
    const endedMs = input.endedAt ? Date.parse(input.endedAt) : NaN;
    for (const f of files) {
      try {
        const s = await stat(f);
        if (Number.isFinite(endedMs) && s.mtimeMs > endedMs) changedCited.push(f);
      } catch {
        missing.push(f);
      }
    }
    if (missing.length) {
      return {
        freshness: "broken",
        reason: `${missing.length}/${files.length} cited file(s) no longer exist: ${sample(missing)}.`,
        changedFiles: changedCited,
        missingFiles: missing,
        basis: "existence",
      };
    }
    if (!Number.isFinite(endedMs)) {
      // files all exist but we have no clock to compare against
      return {
        freshness: "unknown",
        reason: `no git SHA and no session end time — cited files exist but freshness can't be dated (basis: existence only).`,
        changedFiles: [],
        missingFiles: [],
        basis: "existence",
      };
    }
    if (changedCited.length) {
      return {
        freshness: "stale",
        reason: `no git SHA; ${changedCited.length}/${files.length} cited file(s) modified since session end (mtime): ${sample(changedCited)}.`,
        changedFiles: changedCited,
        missingFiles: [],
        basis: "mtime",
      };
    }
    return {
      freshness: "fresh",
      reason: `no git SHA; none of the ${files.length} cited file(s) modified since session end (mtime).`,
      changedFiles: [],
      missingFiles: [],
      basis: "mtime",
    };
  }

  // ---- Strategy 3: nothing checkable ----
  return {
    freshness: "unknown",
    reason: `no git SHA and no files cited — no cheap signal to validate this card either way.`,
    changedFiles: [],
    missingFiles: [],
    basis: "none",
  };
}

async function checkExistence(files: string[]): Promise<FreshnessVerdict | null> {
  if (!files.length) return null;
  const missing: string[] = [];
  for (const f of files) if (!(await exists(f))) missing.push(f);
  if (missing.length)
    return {
      freshness: "broken",
      reason: `${missing.length}/${files.length} cited file(s) no longer exist: ${sample(missing)}.`,
      changedFiles: [],
      missingFiles: missing,
      basis: "existence",
    };
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function short(sha: string): string {
  return sha.slice(0, 10);
}

function sample(files: string[], n = 3): string {
  const shown = files.slice(0, n).map((f) => f.split("/").slice(-2).join("/"));
  return shown.join(", ") + (files.length > n ? `, +${files.length - n} more` : "");
}

/** Test-only: reset the per-process caches so tests don't bleed into each other. */
export function _resetCachesForTest(): void {
  gitOk = undefined;
  diffCache.clear();
  rootCache.clear();
}
