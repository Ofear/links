/** Run: npx tsx src/validate.test.ts — exits non-zero on any failure.
 *
 * Builds a throwaway git repo in tmp to exercise the real `git diff` path, then
 * covers every verdict branch (fresh/stale/broken/unknown) and the graceful
 * no-git degradation. Mirrors scanner.test.ts: plain script, no framework. */
import { exec } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { validateCard, freshnessBadge, _resetCachesForTest } from "./validate.js";

const execFile = promisify(exec);
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}${detail ? ` → ${detail}` : ""}`);
    failed++;
  }
}

const tmpRoot = await mkdtemp(join(tmpdir(), "links-validate-"));
const repo = join(tmpRoot, "repo");
await mkdir(repo, { recursive: true });

async function git(args: string) {
  return execFile(`git -C ${q(repo)} ${args}`, { timeout: 10000 });
}

// --- set up a real repo with one commit ---
await git("init -q");
await git('config user.email t@t.t');
await git('config user.name test');
const fileA = join(repo, "a.ts");
const fileB = join(repo, "b.ts");
await writeFile(fileA, "export const a = 1;\n");
await writeFile(fileB, "export const b = 1;\n");
await git("add -A");
await git('commit -q -m first');
const { stdout: shaOut } = await git("rev-parse HEAD");
const sha = shaOut.trim();

// === 1. fresh: SHA recorded, repo at same HEAD, cited file unchanged ===
{
  _resetCachesForTest();
  const v = await validateCard({ cwd: repo, gitCommit: sha, filesTouched: [fileA] });
  check("fresh: no change since SHA", v.freshness === "fresh", v.freshness + " / " + v.reason);
}

// === 2. stale: cited file changed since the recorded SHA ===
await writeFile(fileA, "export const a = 2; // edited\n");
await git("add -A");
await git('commit -q -m second');
{
  _resetCachesForTest();
  const v = await validateCard({ cwd: repo, gitCommit: sha, filesTouched: [fileA] });
  check("stale: cited file changed since SHA", v.freshness === "stale", v.freshness + " / " + v.reason);
  check("stale: lists the changed file", v.changedFiles.includes(fileA));
  check("stale: basis is git-sha", v.basis === "git-sha", v.basis);
}

// === 2b. a DIFFERENT cited file (b.ts, untouched) stays fresh against same SHA ===
{
  _resetCachesForTest();
  const v = await validateCard({ cwd: repo, gitCommit: sha, filesTouched: [fileB] });
  check("fresh: unrelated cited file untouched since SHA", v.freshness === "fresh", v.freshness + " / " + v.reason);
}

// === 3. broken: cited file deleted ===
await rm(fileB);
await git("add -A");
await git('commit -q -m "delete b"');
{
  _resetCachesForTest();
  const v = await validateCard({ cwd: repo, gitCommit: sha, filesTouched: [fileB] });
  check("broken: cited file gone", v.freshness === "broken", v.freshness + " / " + v.reason);
  check("broken: lists missing file", v.missingFiles.includes(fileB));
}

// === 4. broken: SHA unreachable in this repo (different clone / rewritten) ===
{
  _resetCachesForTest();
  const bogus = "0000000000000000000000000000000000000000";
  // no cited files so it can't fall through to existence — must be broken on SHA
  const v = await validateCard({ cwd: repo, gitCommit: bogus, filesTouched: [] });
  check("broken: unreachable SHA, no files", v.freshness === "broken", v.freshness + " / " + v.reason);
}

// === 5. unknown: no SHA, no files — nothing to check ===
{
  _resetCachesForTest();
  const v = await validateCard({ filesTouched: [] });
  check("unknown: no SHA and no files", v.freshness === "unknown", v.freshness + " / " + v.reason);
  check("unknown: basis none", v.basis === "none", v.basis);
}

// === 6. fallback (no SHA): mtime stale vs endedAt ===
{
  _resetCachesForTest();
  const f = join(tmpRoot, "loose.txt");
  await writeFile(f, "x");
  const ended = new Date(Date.now() - 60_000).toISOString(); // session ended a minute ago
  // bump mtime to now (after endedAt)
  await utimes(f, new Date(), new Date());
  const v = await validateCard({ filesTouched: [f], endedAt: ended });
  check("mtime fallback: stale when file newer than endedAt", v.freshness === "stale", v.freshness + " / " + v.reason);
  check("mtime fallback: basis is mtime", v.basis === "mtime", v.basis);
}

// === 7. fallback (no SHA): file predates endedAt → fresh ===
{
  _resetCachesForTest();
  const f = join(tmpRoot, "old.txt");
  await writeFile(f, "x");
  const old = new Date(Date.now() - 120_000);
  await utimes(f, old, old);
  const ended = new Date().toISOString(); // session ended just now, after file mtime
  const v = await validateCard({ filesTouched: [f], endedAt: ended });
  check("mtime fallback: fresh when file older than endedAt", v.freshness === "fresh", v.freshness + " / " + v.reason);
}

// === 8. fallback (no SHA): missing file → broken via existence ===
{
  _resetCachesForTest();
  const v = await validateCard({ filesTouched: [join(tmpRoot, "does-not-exist.txt")], endedAt: new Date().toISOString() });
  check("existence fallback: missing file is broken", v.freshness === "broken", v.freshness + " / " + v.reason);
  check("existence fallback: basis existence", v.basis === "existence", v.basis);
}

// === 9. graceful: cwd that is NOT a git repo, SHA given, files exist → degrades, no crash ===
{
  _resetCachesForTest();
  const nonRepo = join(tmpRoot, "norepo");
  await mkdir(nonRepo, { recursive: true });
  const f = join(nonRepo, "c.ts");
  await writeFile(f, "x");
  // SHA recorded but cwd isn't a repo → diff fails → existence fallback → file exists → not broken
  const v = await validateCard({ cwd: nonRepo, gitCommit: sha, filesTouched: [f] });
  check("graceful: non-repo cwd does not crash", v.freshness === "fresh" || v.freshness === "unknown" || v.freshness === "broken", v.freshness);
  // file exists so checkExistence returns null → falls to broken (SHA unreachable). Either way: no throw, a verdict.
  check("graceful: produced a verdict", typeof v.freshness === "string");
}

// === 10. badge rendering surfaces the signal for each verdict ===
{
  for (const fr of ["fresh", "stale", "broken", "unknown"] as const) {
    const badge = freshnessBadge({ freshness: fr, reason: "r.", changedFiles: [], missingFiles: [], basis: "none" });
    check(`badge: ${fr} renders non-empty`, badge.length > 0 && badge.includes("freshness"), badge);
  }
  check("badge: stale warns to verify", freshnessBadge({ freshness: "stale", reason: "r.", changedFiles: [], missingFiles: [], basis: "git-sha" }).includes("Verify"));
}

await rm(tmpRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
