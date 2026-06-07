/** Run: npx tsx src/scanner.test.ts — exits non-zero on any leak. */
import { redact } from "./scanner.js";

const cases: { name: string; input: string; mustNotContain: string }[] = [
  {
    name: "npmrc authToken (verified real leak shape, 520b8330)",
    input: "//npm.dev.wixpress.com/:_authToken=npm_tDmHYLaZabcdefghij1234567890ABCDEFmn",
    mustNotContain: "npm_tDmHYLaZ",
  },
  { name: "bare npm token", input: "token is npm_AbCdEf123456789012345678901234567890", mustNotContain: "npm_AbCdEf" },
  { name: "anthropic key", input: "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAA", mustNotContain: "sk-ant-api03" },
  { name: "github pat", input: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", mustNotContain: "ghp_ABCDEF" },
  { name: "slack token", input: "xoxb-1234567890-abcdefghij", mustNotContain: "xoxb-1234567890" },
  { name: "jwt", input: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", mustNotContain: "SflKxwRJ" },
  { name: "password assignment", input: 'password: "hunter2hunter2hunter2"', mustNotContain: "hunter2" },
  { name: "E.164 phone (PII, real leak shape d477e3df)", input: "send sms from +972528896808 ok", mustNotContain: "528896808" },
];

let failed = 0;
for (const c of cases) {
  const { text } = redact(c.input);
  if (text.includes(c.mustNotContain)) {
    console.error(`✗ LEAK: ${c.name} → ${text}`);
    failed++;
  } else {
    console.log(`✓ ${c.name}`);
  }
}
// regression: long file paths must survive (false positive found on real card)
const path = redact(
  "/home/ofirh/Projects/Wix/glow-up/packages/glow-up/src/client/components/ScanTasksBadge/ScanTasksBadge.module.css",
).text;
if (path.includes("REDACTED")) {
  console.error(`✗ OVER-REDACTION of file path: ${path}`);
  failed++;
} else {
  console.log("✓ file paths survive");
}
// sanity: normal prose must survive
const prose = redact("Fixed the @wix:registry scope in ~/.npmrc, package resolved to 1.6.0").text;
if (prose.includes("REDACTED")) {
  console.error(`✗ OVER-REDACTION: ${prose}`);
  failed++;
} else {
  console.log("✓ prose survives");
}
process.exit(failed ? 1 : 0);
