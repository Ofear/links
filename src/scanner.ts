/**
 * Deterministic secret scanner — the redaction MECHANISM (the LLM is only a
 * supplement). Runs on transcript text before extraction AND on final card
 * markdown, because cards travel further than transcripts.
 */

const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { label: "openai-key", re: /sk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}/g },
  { label: "github-token", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g },
  { label: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: "aws-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  // npm granular/classic tokens (npm_ + 36 base62 ≈ 40 chars — under the entropy floor)
  { label: "npm-token", re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  // E.164 phone numbers — PII; found leaking on card cc-2026-05-13-d477e3df (2026-06-07)
  { label: "phone", re: /\+\d{10,14}\b/g },
  {
    // no leading \b: must catch `_authToken=...` (npm .npmrc style) — verified
    // leak shape from session 520b8330 on 2026-06-07
    label: "credential-assignment",
    re: /(_?auth[_-]?token|api[_-]?key|secret|password|client[_-]?secret)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/gi,
  },
];

/** Standalone high-entropy blobs (hex ≥40 or dense base64 ≥48) not caught above. */
const ENTROPY_RES = [/\b[0-9a-f]{40,}\b/gi, /\b[A-Za-z0-9+/]{48,}={0,2}\b/g];

function looksHighEntropy(s: string): boolean {
  // File paths (camelCase segments joined by "/") match the base64 charset but
  // are not secrets — verified false positive on card cc-2026-05-12-c4719074
  // (files_touched got shredded). Real tokens essentially always carry digits;
  // multi-slash strings are paths.
  if ((s.match(/\//g) ?? []).length >= 2) return false;
  if ((s.match(/[0-9]/g) ?? []).length < 2) return false;
  const classes =
    Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/[0-9]/.test(s)) + Number(/[+/=]/.test(s));
  return classes >= 3 || /^[0-9a-f]+$/i.test(s);
}

export function redact(text: string): { text: string; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  let out = text;
  for (const { label, re } of PATTERNS) {
    out = out.replace(re, () => {
      hits[label] = (hits[label] ?? 0) + 1;
      return `[REDACTED:${label}]`;
    });
  }
  for (const re of ENTROPY_RES) {
    out = out.replace(re, (m, offset: number, full: string) => {
      if (!looksHighEntropy(m)) return m;
      // A 40/64-hex SHA on a line WE author (`git_commit:`) is a commit hash from
      // ground truth, not a secret — keep it readable. The label prefix is the
      // discriminator: real secrets never sit on a git_commit line. Everywhere
      // else, 40-hex stays redacted (UUID-no-dash / unknown blob — prefer safety).
      const lineStart = full.lastIndexOf("\n", offset) + 1;
      if (/^git_commit:\s*$/.test(full.slice(lineStart, offset)) && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(m)) {
        return m;
      }
      hits["high-entropy"] = (hits["high-entropy"] ?? 0) + 1;
      return "[REDACTED:high-entropy]";
    });
  }
  return { text: out, hits };
}
