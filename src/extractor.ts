/**
 * Card extractor — codex-backed (keeps Claude quota for development, per user).
 *
 * Engine: `codex exec` headless with:
 *   --ephemeral        CRITICAL: extraction must not write new sessions into
 *                      ~/.codex/sessions — links must never pollute the corpus
 *                      it indexes
 *   --output-schema    schema-forced JSON (validated by codex at the response
 *                      layer; we still parse-validate and retry once)
 *   -s read-only       extraction needs no writes or commands
 *
 * Chunked map-reduce (load-bearing — max session ≈ 5M tokens):
 *   rendered ≤ CHUNK_CHARS → single pass
 *   above → per-chunk partial extraction → merge pass over partial JSONs
 * Message indices [msg N] are global (adapter's stable index rule), so
 * evidence pointers survive chunking.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { platform } from "node:process";
import { join } from "node:path";
import { readMessagesFor } from "./adapters/index.js";
import { redact } from "./scanner.js";
import type { NormalizedMessage, SessionMeta } from "./types.js";

export const EXTRACTOR_VERSION = 2; // v2: preserve reference URLs/paths; capture artifact content for doc sessions; exclude harness mechanics from rules

/** Safe temp directory cleanup with retry for Windows file-locking races. */
async function safeRm(path: string): Promise<void> {
  if (platform !== "win32") {
    await rm(path, { recursive: true, force: true });
    return;
  }
  // On Windows, files can remain locked for ~100-500ms after process exit.
  // Retry with exponential backoff up to 2s total.
  const maxAttempts = 8;
  const baseDelay = 50;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e: any) {
      if (e.code !== "EBUSY" && e.code !== "EPERM") throw e;
      if (attempt === maxAttempts - 1) {
        // Last attempt: log but don't throw — orphaned temp dirs are harmless
        console.warn(`[links] Failed to clean up temp dir ${path}: ${e.message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
    }
  }
}

const CHUNK_CHARS = 320_000; // ~80k tokens — safe under codex context
const MAX_MSG_CHARS = 1_600;
const MAX_TOOL_RESULT_CHARS = 600;
const CODEX_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- card JSON shape (mirrors schema/card.schema.json) ----------
export interface EvidencedItem {
  text: string;
  /** [first, last] global message indices supporting the claim. */
  msgs: [number, number];
}
export interface CardData {
  intent: string;
  outcome: "succeeded" | "partial" | "abandoned" | "unknown";
  summary: EvidencedItem[];
  decisions: EvidencedItem[];
  issues: EvidencedItem[];
  rules: EvidencedItem[];
  entities: string[];
}

// ---------- codex binary resolution ----------
let codexBin: string | undefined;
export async function resolveCodex(): Promise<string> {
  if (codexBin) return codexBin;
  const { config, expandHome } = await import("./config.js");
  if (config().codexBin) return (codexBin = config().codexBin!);
  if (process.env.CODEX_BIN) return (codexBin = process.env.CODEX_BIN);
  // A bundled native binary (default: Cursor's openai.chatgpt extension) — all
  // machine-specific bits are config().codexFallback so other OSes can repoint.
  const fb = config().codexFallback;
  const extDir = expandHome(fb.extensionsDir);
  const exts = (await readdir(extDir).catch(() => []))
    .filter((d) => d.startsWith(fb.extensionPrefix))
    .sort()
    .reverse();
  for (const e of exts) {
    const candidate = join(extDir, e, fb.binRelPath);
    try {
      await readFile(join(extDir, e, `${fb.binRelPath}-package.json`));
      return (codexBin = candidate);
    } catch {
      /* try next */
    }
  }
  return (codexBin = "codex"); // hope for PATH
}

/** Run codex exec with the prompt on STDIN (argv is capped at 128KB on Linux). */
function runCodex(bin: string, args: string[], stdin: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex timed out after ${CODEX_TIMEOUT_MS / 1000}s`));
    }, CODEX_TIMEOUT_MS);
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString().slice(0, 4000)));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`codex exit ${code}: ${stderr.slice(-1500)}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Generic schema-forced codex call — also used by the benchmark judge. */
export async function codexStructured<T>(prompt: string, schemaPath: string): Promise<T> {
  return codexJson(prompt, schemaPath) as Promise<T>;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

async function codexJson(prompt: string, schemaPath: string): Promise<CardData> {
  const bin = await resolveCodex();
  const work = await mkdtemp(join(tmpdir(), "links-codex-"));
  const outFile = join(work, "out.json");
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await runCodex(
          bin,
          [
            "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
            "--ignore-user-config", "-C", work,
            "--output-schema", schemaPath, "-o", outFile, "-",
          ],
          prompt,
          work,
        );
        const raw = (await readFile(outFile, "utf8")).trim();
        return JSON.parse(stripFences(raw)) as CardData;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  } finally {
    await safeRm(work);
  }
}

// ---------- claude headless engine (for friends who have Claude Code, not codex) ----------
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;

/** Run `claude -p` headless, return the assistant's text (the JSON envelope's `result`). */
function runClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = process.env.CLAUDE_BIN || "claude";
    const child = spawn(bin, ["-p", "--output-format", "json", "--model", process.env.LINKS_CLAUDE_MODEL || "haiku"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`)); }, CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString().slice(0, 4000)));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(-1500)}`));
      try {
        const env = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (env.is_error) return reject(new Error(`claude error: ${String(env.result ?? "").slice(0, 800)}`));
        resolve(String(env.result ?? ""));
      } catch {
        reject(new Error(`claude output not JSON: ${out.slice(0, 400)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function claudeJson(prompt: string, schemaPath: string): Promise<CardData> {
  const schema = await readFile(schemaPath, "utf8");
  // run in a sentinel-named temp cwd; the adapter skips project dirs containing
  // "links-ephemeral", so claude's own extraction transcript never pollutes the
  // corpus (the claude equivalent of codex's --ephemeral).
  const work = await mkdtemp(join(tmpdir(), "links-ephemeral-"));
  const full =
    `${prompt}\n\nOUTPUT FORMAT: respond with ONLY a single JSON object conforming to this JSON Schema — ` +
    `no markdown, no code fences, no prose before or after:\n${schema}`;
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return JSON.parse(stripFences((await runClaude(full, work)).trim())) as CardData;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  } finally {
    await safeRm(work);
  }
}

/** Dispatch extraction to the configured engine. codex (default) is --ephemeral-clean;
 *  claude is for friends who have Claude Code but not codex. */
async function extractJson(prompt: string, schemaPath: string): Promise<CardData> {
  const { config } = await import("./config.js");
  if (config().extractionEngine === "claude") return claudeJson(prompt, schemaPath);
  return codexJson(prompt, schemaPath); // "codex" default; "api-key" reserved → codex
}

// ---------- transcript rendering ----------
function renderMessage(m: NormalizedMessage): string {
  const parts: string[] = [];
  const text = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + " …[truncated]" : m.text;
  const tools = m.toolUses?.map((t) => t.target ? `${t.name}(${t.target})` : t.name).join(", ");
  parts.push(`[msg ${m.index}] ${m.role.toUpperCase()}${tools ? ` (tools: ${tools})` : ""}: ${text}`);
  for (const r of m.toolResults ?? []) {
    const rt = r.length > MAX_TOOL_RESULT_CHARS ? r.slice(0, MAX_TOOL_RESULT_CHARS) + " …[truncated]" : r;
    parts.push(`  [msg ${m.index} tool-result] ${rt}`);
  }
  return parts.join("\n");
}

export function renderChunks(messages: NormalizedMessage[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const m of messages) {
    const rendered = renderMessage(m);
    if (size + rendered.length > CHUNK_CHARS && current.length) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(rendered);
    size += rendered.length;
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

// ---------- prompts ----------
function extractionPrompt(meta: SessionMeta, transcript: string, chunkInfo?: string): string {
  return `You are an extraction engine for "links", a session-memory system. Your output
is a metadata card that lets a FUTURE coding agent decide in ~300 tokens whether this
past session contains work it can reuse instead of re-investigating.

Optimize for that reader: concrete nouns (file paths, error codes, API names, root
causes), no filler, no praise. If the session ended without resolving its goal, say so
honestly — outcome "partial" or "abandoned". A misleading card is worse than no card.

Every summary/decision/issue/rule item MUST carry "msgs": [first, last] — the global
message indices (from the [msg N] markers) where the claim is supported. Use tight
ranges (the specific exchange), not the whole session. ONLY use indices that appear
as literal [msg N] markers in the transcript below — never invent or extrapolate
indices. Wrong evidence pointers are worse than none.

Fields:
- intent: one line — what the user was trying to achieve.
- outcome: succeeded | partial | abandoned | unknown.
- summary: 3-7 items — what was actually done/found (root causes first). PRESERVE exact
  reference URLs, repo paths, and file paths that were USED as sources — "based on the
  Alfred reference" is useless; "based on github.com/org/alfred/.../sms.ts" is reusable.
- decisions: choices made and WHY (these age well — capture rationale).
- issues: problems hit, bugs found, things flagged for later.
- rules: durable instructions/preferences the user stated (e.g. "never X", "always Y").
  ONLY user-stated preferences — never harness mechanics, system-reminder text, or
  tool-caveat boilerplate.
- entities: searchable proper nouns — services, APIs, packages, error codes, hostnames.

SPECIAL CASE — if the session's main output was a DOCUMENT (onboarding brief, design doc,
handoff, README): the summary must capture the document's KEY CONTENT (purpose, main
points), not just "a document was written". A future agent asks "what does the project
do?" — the card should answer that, with the doc's path for the full version.

Session metadata: tool=${meta.tool} project=${meta.project} date=${meta.startedAt?.slice(0, 10) ?? "?"} title="${meta.title}"
${chunkInfo ?? ""}
TRANSCRIPT:
${transcript}`;
}

function mergePrompt(meta: SessionMeta, partials: CardData[]): string {
  return `You are merging partial extraction results from consecutive chunks of ONE long
session into a single card. Combine and dedupe items; keep the most specific phrasing;
preserve each item's original "msgs" indices (they are global and already correct).
The final outcome should reflect the END state of the session (later chunks win).
Cap summary at 7 items, decisions/issues/rules at 6 each. entities: union, deduped.

Session metadata: project=${meta.project} title="${meta.title}"

PARTIAL RESULTS (in chunk order):
${JSON.stringify(partials, null, 1)}`;
}

/**
 * Evidence-pointer integrity: indices beyond the real message count are model
 * hallucinations (verified on card cc-2026-05-27-f12390a9: msg_count 1950,
 * pointers up to 2117). Clamp into range and report — a wrong slice read is
 * worse than a slightly-wide one.
 */
export function clampEvidence(data: CardData, msgCount: number): { data: CardData; violations: number } {
  let violations = 0;
  const max = Math.max(0, msgCount - 1);
  const fix = (items: EvidencedItem[]) =>
    items.map((i) => {
      const [a, b] = i.msgs;
      if (a <= max && b <= max && a <= b) return i;
      violations++;
      return { ...i, msgs: [Math.min(a, max), Math.min(Math.max(a, b), max)] as [number, number] };
    });
  return {
    data: {
      ...data,
      summary: fix(data.summary),
      decisions: fix(data.decisions),
      issues: fix(data.issues),
      rules: fix(data.rules),
    },
    violations,
  };
}

// ---------- main entry ----------
export async function extractCard(
  meta: SessionMeta,
  schemaPath: string,
  log: (s: string) => void = () => {},
): Promise<CardData> {
  const messages = await readMessagesFor(meta);
  const chunks = renderChunks(messages).map((c) => redact(c).text);
  log(`  ${chunks.length} chunk(s)`);
  let result: CardData;
  if (chunks.length === 1) {
    result = await extractJson(extractionPrompt(meta, chunks[0]!), schemaPath);
  } else {
    const partials: CardData[] = [];
    for (let i = 0; i < chunks.length; i++) {
      log(`  chunk ${i + 1}/${chunks.length}`);
      partials.push(
        await extractJson(
          extractionPrompt(meta, chunks[i]!, `NOTE: chunk ${i + 1} of ${chunks.length} of a long session.\n`),
          schemaPath,
        ),
      );
    }
    log(`  merging ${partials.length} partials`);
    result = await extractJson(mergePrompt(meta, partials), schemaPath);
  }
  const { data, violations } = clampEvidence(result, messages.length);
  if (violations) log(`  ⚠ clamped ${violations} out-of-range evidence pointer(s)`);
  return data;
}