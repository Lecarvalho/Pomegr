#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { defaultAgentQueryDataRoot, readAgentQueryDescriptor } from "../shared/agent-query-transport.mjs";
import { createTaskBindingProof } from "./task-binding-proof.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOOL = /^mcp__(?:plugin_pomegr_pomegr|pomegr)__(get_session_report|list_session_agents|get_agent_context|get_recent_failures)$/u;
const WRITE_TOOL = /^mcp__(?:plugin_pomegr_pomegr|pomegr)__(add_task|complete_task|block_task)$/u;
const WRITE_FIELDS = {
  add_task: ["text", "provider", "model", "effort", "done_when", "own_condition", "feature"],
  complete_task: [],
  block_task: ["reason"],
};
const WRITE_DENIED = {
  add_task: "Pomegr could not bind this task to the current session, so it was not added.",
  complete_task: "Pomegr could not bind this report to the current session, so nothing was reported.",
  block_task: "Pomegr could not bind this report to the current session, so nothing was reported.",
};
const SELF_GRANTED = "get_agent_context";
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

/** The local agent-query capability the server verifies a binding proof against; null when unavailable. */
async function defaultReadToken() {
  try {
    return (await readAgentQueryDescriptor({ dataRoot: defaultAgentQueryDataRoot() }))?.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Write tools never honor a model-supplied selector. The binding is the host's
 * current transcript, signed with the local capability so the MCP server can tell
 * this value from one the model typed, or the call is denied. No permission
 * decision is allowed here, so the host still asks the user as it normally would
 * for a write. The token and the proof reach stdout only as `session_proof`.
 */
async function bindWriteTool(payload, name, { readToken = defaultReadToken, now = Date.now } = {}) {
  const deny = { hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: WRITE_DENIED[name],
  } };
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !WRITE_FIELDS[name].includes(key))) return deny;
  const id = currentSessionId(payload.transcript_path);
  if (!id) return deny;
  const sessionRef = `claude:${id}`;
  let proof = null;
  try {
    proof = createTaskBindingProof({ token: await readToken(), tool: name, sessionRef, now: now() });
  } catch { /* No proof is a denial; never echo why. */ }
  if (!proof) return deny;
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: { ...input, session_ref: sessionRef, session_proof: proof },
  } };
}

/** Reads resolve synchronously; a write tool resolves to its signed binding or a denial, so callers await. */
export function bindClaudeQuerySession(payload, options = {}) {
  if (payload?.hook_event_name !== "PreToolUse") return null;
  const write = typeof payload.tool_name === "string" ? WRITE_TOOL.exec(payload.tool_name) : null;
  if (write) return bindWriteTool(payload, write[1], options);
  const match = typeof payload.tool_name === "string" ? TOOL.exec(payload.tool_name) : null;
  if (!match) return null;
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !FIELDS[match[1]].includes(key))) return null;
  // Explicit historical/delegated selectors still go through MCP schema validation (reads only).
  if (Object.hasOwn(input, "session_ref")) return null;
  const id = currentSessionId(payload.transcript_path);
  if (!id) return null;
  // session_id and launch environment can still identify the pre-/clear session.
  // The only permission decision is for the read the Pomegr line makes of the session's
  // own context, bound here to the current session. Every other tool, and any explicit
  // selector, leaves authorization to the host.
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    ...(match[1] === SELF_GRANTED ? { permissionDecision: "allow" } : {}),
    updatedInput: { ...input, session_ref: `claude:${id}` },
  } };
}

export async function runClaudeQuerySessionHook(stream = process.stdin, output = process.stdout, options = {}) {
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
    const result = await bindClaudeQuerySession(JSON.parse(Buffer.concat(chunks).toString("utf8")), options);
    if (result) output.write(`${JSON.stringify(result)}\n`);
  } catch { /* Missing binding fails unavailable in MCP; never echo hook content. */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runClaudeQuerySessionHook();
