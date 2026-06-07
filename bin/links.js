#!/usr/bin/env node
// links CLI entry — thin wrapper so `npx links <cmd>` / `npm link` work.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const child = spawn(tsx, [join(root, "src", "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("close", (code) => process.exit(code ?? 1));
