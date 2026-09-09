#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOOL = /^mcp__(?:plugin_pomegr_pomegr|pomegr)__(get_session_report|list_session_agents|get_agent_context|get_recent_failures)$/u;
const FIELDS = {
  get_session_report: ["session_ref"],
  list_session_agents: ["session_ref"],
  get_agent_context: ["session_ref", "agent_id"],
  get_recent_failures: ["session_ref", "agent_id", "within_minutes", "limit"],
};

/** Use only the host's current transcript locator; never open or emit the path. */
function currentSessionId(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(transcriptPath) || !path.isAbsolute(transcriptPath)) return null;
  const filename = path.basename(transcriptPath);
  if (!filename.endsWith(".jsonl")) return null;
  const id = filename.slice(0, -6);
  if (UUID.test(id)) return id;
  // A delegated transcript lives under its owning session's subagents directory.
  const directory = path.dirname(transcriptPath);
  const owner = path.basename(path.dirname(directory));
  return /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/u.test(filename)
    && path.basename(directory) === "subagents" && UUID.test(owner) ? owner : null;
}

export function bindClaudeQuerySession(payload) {
  if (payload?.hook_event_name !== "PreToolUse") return null;
  const match = typeof payload.tool_name === "string" ? TOOL.exec(payload.tool_name) : null;
  if (!match) return null;
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !FIELDS[match[1]].includes(key))) return null;
  // Explicit historical/delegated selectors still go through MCP schema validation.
  if (Object.hasOwn(input, "session_ref")) return null;
  const id = currentSessionId(payload.transcript_path);
  if (!id) return null;
  // session_id and launch environment can still identify the pre-/clear session.
  // No permission decision: normal tool authorization remains the host's concern.
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: { ...input, session_ref: `claude:${id}` },
  } };
}

export async function runClaudeQuerySessionHook(stream = process.stdin, output = process.stdout) {
  if (stream.isTTY) return;
  let bytes = 0;
  const chunks = [];
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT_BYTES) {
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const result = bindClaudeQuerySession(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (result) output.write(`${JSON.stringify(result)}\n`);
  } catch { /* Missing binding fails unavailable in MCP; never echo hook content. */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runClaudeQuerySessionHook();
