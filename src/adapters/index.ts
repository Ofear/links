/** Adapter dispatch — one place that knows which tool parses which transcript. */
import type { NormalizedMessage, SessionMeta } from "../types.js";
import * as claudeCode from "./claudeCode.js";
import * as codex from "./codex.js";

export async function scanAllSessions(): Promise<SessionMeta[]> {
  const metas: SessionMeta[] = [];
  for (const f of await claudeCode.listSessionFiles()) metas.push(await claudeCode.scanSession(f));
  for (const f of await codex.listSessionFiles()) metas.push(await codex.scanSession(f));
  return metas;
}

export async function readMessagesFor(meta: Pick<SessionMeta, "tool" | "sourcePath">): Promise<NormalizedMessage[]> {
  switch (meta.tool) {
    case "claude-code":
      return claudeCode.readMessages(meta.sourcePath);
    case "codex":
      return codex.readMessages(meta.sourcePath);
    default:
      throw new Error(`no adapter for tool ${meta.tool}`);
  }
}
