#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentQueryReader, defaultAgentQueryDataRoot } from "../shared/agent-query-transport.mjs";
import { evaluateUsageGuard, usageGuardNotice } from "../shared/usage-guard-policy.mjs";
import { guardHash, openGuardState, readUsageGuardConfig } from "./usage-guard-state.mjs";

export const USAGE_GUARD_MAX_INPUT_BYTES = 1024 * 1024;
export const USAGE_GUARD_MAX_CONTEXT_BYTES = 1600;
const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolBatch"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** Advisory only: no provider control, transcript reads, or model calls. */
export async function handleUsageGuard(payload, options = {}) {
  const provider = options.provider;
  if (!["claude", "codex"].includes(provider) || !payload || typeof payload !== "object"
    || !EVENTS.has(payload.hook_event_name)
    || typeof payload.session_id !== "string" || !SAFE_ID.test(payload.session_id)
    || typeof payload.cwd !== "string") return null;
  // Native agent identity keeps parallel workers' reminders separate; it is hashed
  // before storage and never included in a notice or monitor request.
  const actor = payload.agent_id;
  if (actor !== undefined && actor !== null && actor !== "" && (typeof actor !== "string" || !SAFE_ID.test(actor))) return null;
  const policy = readUsageGuardConfig(payload.cwd);
  if (!policy || policy.config.mode !== "advisory") return null;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) return null;
  const dataRoot = options.dataRoot || defaultAgentQueryDataRoot();
  const identity = `${provider}:${payload.session_id}:${actor || "primary"}`;
  const state = openGuardState(dataRoot, identity, now);
  if (!state) return null;
  try {
    const configHash = guardHash(JSON.stringify(policy.config));
    const previous = state.previous?.configHash === configHash ? state.previous : null;
    const starting = payload.hook_event_name === "SessionStart";
    if (previous && now - previous.lastCheckAt < policy.config.checkIntervalSeconds * 1000) return null;
    let snapshot;
    try {
      const query = options.query || createAgentQueryReader({ dataRoot });
      snapshot = await query("/api/agent/v1/usage-limits", { provider });
    } catch { snapshot = null; }
    // A background monitor publication may occur while the local GET is in
    // flight. Judge its age at receipt, not against the earlier request time.
    const receivedAt = options.now ?? Date.now();
    const decision = evaluateUsageGuard(snapshot, provider, policy.config, receivedAt);
    // Commit the check even when nothing changed: low usage remains silent and
    // unavailable observations cannot create an MCP/tool recursion loop.
    if (!state.save({ stage: decision.stage, configHash, lastCheckAt: receivedAt })) return null;
    if (!starting && previous?.stage === decision.stage) return null;
    let notice = usageGuardNotice(decision, provider);
    if (!notice && previous && previous.stage !== "normal") {
      notice = "[Pomegr usage guard] Fresh shared-usage observations are below the configured warning threshold again. This is not a capacity guarantee; other windows, accounts, or machines may differ. Keep the workspace handoff available. No automatic resume was performed.";
    }
    if (!notice || Buffer.byteLength(notice, "utf8") > USAGE_GUARD_MAX_CONTEXT_BYTES) return null;
    return { hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: notice } };
  } finally { state.close(); }
}

/** Discard all unneeded hook fields; never retain or emit raw hook/tool content. */
async function readPayload(stream) {
  const chunks = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > USAGE_GUARD_MAX_INPUT_BYTES) {
      oversized = true;
      chunks.length = 0;
    } else if (!oversized) chunks.push(Buffer.from(chunk));
  }
  if (oversized || !bytes) return null;
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { hook_event_name: value?.hook_event_name, session_id: value?.session_id, cwd: value?.cwd, agent_id: value?.agent_id };
  } catch { return null; }
}

export async function runUsageGuard() {
  try {
    const args = process.argv.slice(2);
    const provider = args[args.indexOf("--provider") + 1];
    if (process.stdin.isTTY) return;
    const output = await handleUsageGuard(await readPayload(process.stdin), { provider });
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch { /* Hooks always exit successfully without raw error output. */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runUsageGuard();
