// The two files a chat run is started with, besides the prompt: the fixed instructions Claude reads from a file, and the chat's own
// MCP server. Both hold nothing the owner typed, nothing from the board, and no credential.

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import { AGENT_CHAT_INSTRUCTIONS } from "./agent-chat-prompt.mjs";
import { validInstructionsFile } from "./agent-chat-runner.mjs";
import { AGENT_CHAT_DIRECTORY } from "./agent-chat-store.mjs";

const MCP_WORKER = ["desktop", "workers", "agent-chat-mcp.cjs"];

// Only fixed instructions enter this file; an unavailable file leaves the turn's stdin form intact.
export async function prepareInstructionsFile(dataRoot, content = AGENT_CHAT_INSTRUCTIONS) {
  let temporary;
  try {
    if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) return null;
    const folder = path.join(dataRoot, AGENT_CHAT_DIRECTORY);
    const file = path.join(folder, `instructions-${createHash("sha256").update(content).digest("hex")}.md`);
    const instructions = { folder, file };
    if (!validInstructionsFile(instructions)) return null;
    if (await fs.readFile(file, "utf8").catch(() => null) === content) return instructions;
    await fs.mkdir(folder, { recursive: true });
    temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
    return instructions;
  } catch { return null; }
  finally { if (temporary) await fs.rm(temporary, { force: true }).catch(() => {}); }
}

/** The chat's own MCP server: the desktop executable running the bundled read-only server as Node. Null when it is not built. */
export function agentChatMcpServer({ executable, unpackedRoot, fileExists = existsSync } = {}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable) || typeof unpackedRoot !== "string" || !path.isAbsolute(unpackedRoot)) return null;
  const script = path.join(unpackedRoot, ...MCP_WORKER);
  let present = false;
  try { present = fileExists(script) === true; } catch { present = false; }
  return present ? Object.freeze({ command: executable, args: Object.freeze([script]), env: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }) }) : null;
}
