#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { defaultAgentQueryDataRoot, readAgentQueryDescriptor } from "../shared/agent-query-transport.mjs";
import { createTaskBindingProof } from "./task-binding-proof.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOOL = /^mcp__(?:plugin_pomegr_pomegr|pomegr)__(get_session_report|list_session_agents|get_agent_context|get_recent_failures)$/u;
const WRITE_TOOL = /^mcp__(?:plugin_pomegr_pomegr|pomegr)__(add_task|get_task|list_tasks|update_task|remove_task|assign_task|unassign_task|complete_task|report_review|block_task|get_feature|create_feature|update_feature|delete_feature)$/u;
const WRITE_FIELDS = {
  add_task: ["text", "provider", "model", "effort", "remote_control", "complete_when", "own_condition", "feature", "runs_after"],
  get_task: ["task_id"],
  list_tasks: ["query", "state", "feature", "editable"],
  update_task: ["task_id", "text", "provider", "model", "effort", "complete_when", "own_condition", "runs_after"],
  remove_task: ["task_id"],
  assign_task: ["task_id"],
  unassign_task: ["task_id"],
  complete_task: ["attention", "task_id", "reworks"],
  report_review: ["verdict", "reasons", "task_id"],
  block_task: ["reason", "task_id", "reworks"],
  get_feature: ["feature", "task_id"],
  create_feature: ["title", "description", "app_version"],
  update_feature: ["feature", "title", "description", "app_version"],
  delete_feature: ["feature"],
};
const FEATURE_OUTCOME = "so no feature was read or changed";
const READ_OUTCOME = "so no task was read";
const WRITE_OUTCOME = {
  add_task: "so no task was added",
  get_task: READ_OUTCOME,
  list_tasks: READ_OUTCOME,
  update_task: "so no task was changed",
  remove_task: "so no task was removed",
  assign_task: "so no task was assigned",
  unassign_task: "so no task was unassigned",
  complete_task: "so nothing was reported",
  report_review: "so no verdict was recorded",
  block_task: "so nothing was reported",
  get_feature: FEATURE_OUTCOME,
  create_feature: FEATURE_OUTCOME,
  update_feature: FEATURE_OUTCOME,
  delete_feature: FEATURE_OUTCOME,
};
const FIELD_HINT = { complete_task: " A plain completion takes no field." };
// One fixed sentence per tool and cause; none carries input, an error, a path, or the token.
const WRITE_DENIED = Object.fromEntries(Object.entries(WRITE_OUTCOME).map(([name, outcome]) => [name, {
  field: `${name} takes only these fields: ${WRITE_FIELDS[name].join(", ")}. This call held another field, ${outcome}.${FIELD_HINT[name] ?? ""} Retry once with only those fields.`,
  session: `Pomegr found no Claude Code session for this call, ${outcome}. Do not retry; tell the user.`,
  proof: `Pomegr could not sign this call for the current session, ${outcome}. Pomegr may not be running; do not retry, tell the user.`,
}]));
// The reads of the session's own board: bound and signed like a write, and approved like the session's own context read.
const WRITE_SELF_GRANTED = new Set(["get_feature", "get_task", "list_tasks"]);
const SELF_GRANTED = "get_agent_context";
const FIELDS = {
  get_session_report: ["session_ref"],
  list_session_agents: ["session_ref"],
  get_agent_context: ["session_ref", "agent_id"],
  get_recent_failures: ["session_ref", "agent_id", "within_minutes", "limit"],
};

// Use only the host's current transcript locator; never open or emit the path.
function currentSessionId(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(transcriptPath) || !path.isAbsolute(transcriptPath)) return null;
  const filename = path.basename(transcriptPath);
  if (!filename.endsWith(".jsonl")) return null;
  const id = filename.slice(0, -6);
  if (UUID.test(id)) return id;
  const directory = path.dirname(transcriptPath);
  const owner = path.basename(path.dirname(directory));
  return /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/u.test(filename)
    && path.basename(directory) === "subagents" && UUID.test(owner) ? owner : null;
}

async function defaultReadToken() {
  try {
    return (await readAgentQueryDescriptor({ dataRoot: defaultAgentQueryDataRoot() }))?.token ?? null;
  } catch {
    return null;
  }
}

export async function bindClaudeQueryWrite(payload, { readToken = defaultReadToken, now = Date.now } = {}) {
  if (payload?.hook_event_name !== "PreToolUse") return null;
  const match = typeof payload.tool_name === "string" ? WRITE_TOOL.exec(payload.tool_name) : null;
  if (!match) return null;
  const name = match[1];
  const deny = (cause) => ({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: WRITE_DENIED[name][cause],
  } });
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !WRITE_FIELDS[name].includes(key))) return deny("field");
  const id = currentSessionId(payload.transcript_path);
  if (!id) return deny("session");
  const sessionRef = `claude:${id}`;
  let proof = null;
  try {
    proof = createTaskBindingProof({ token: await readToken(), tool: name, sessionRef, now: now() });
  } catch { /* No proof is a denial; never echo why. */ }
  if (!proof) return deny("proof");
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    ...(WRITE_SELF_GRANTED.has(name) ? { permissionDecision: "allow" } : {}),
    updatedInput: { ...input, session_ref: sessionRef, session_proof: proof },
  } };
}

// Binds the current session for a read tool, synchronously.
export function bindClaudeQuerySession(payload) {
  if (payload?.hook_event_name !== "PreToolUse") return null;
  const match = typeof payload.tool_name === "string" ? TOOL.exec(payload.tool_name) : null;
  if (!match) return null;
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !FIELDS[match[1]].includes(key))) return null;
  // Explicit historical/delegated selectors still go through MCP schema validation (reads only).
  if (Object.hasOwn(input, "session_ref")) return null;
  const id = currentSessionId(payload.transcript_path);
  if (!id) return null;
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
    const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = (await bindClaudeQueryWrite(event, options)) ?? bindClaudeQuerySession(event);
    if (result) output.write(`${JSON.stringify(result)}\n`);
  } catch { /* Missing binding fails unavailable in MCP; never echo hook content. */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runClaudeQuerySessionHook();
