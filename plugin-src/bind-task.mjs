#!/usr/bin/env node

/*
 * SessionStart (startup) hook that links a session started by the Pomegr task
 * dispatcher to its task, shared by the Claude Code and Codex plugins (`--provider
 * codex` selects Codex). Both hosts add a SessionStart hook's stdout to the model's
 * context, so this script is silent in every outcome:
 * it never writes to stdout or stderr, never logs, and always exits 0. The
 * dispatch token is read only from the environment and sent only in the body of
 * one loopback POST; the session ID comes from the hook input, never from the model.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  AGENT_QUERY_TIMEOUT_MS,
  AGENT_TASK_BIND_PATH,
  createAgentTaskWriter,
  defaultAgentQueryDataRoot,
} from "../shared/agent-query-transport.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
// Below the 5 s hook timeout: one attempt, then the hook ends whatever the monitor does.
const DEADLINE_MS = 3_000;
const TOKEN_ENVIRONMENT_NAME = "POMEGR_TASK_TOKEN";
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function readPayload(stream) {
  if (stream.isTTY) return null;
  let bytes = 0;
  const chunks = [];
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT_BYTES) return null;
      chunks.push(Buffer.from(chunk));
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The hook's own session ID, or null when this input is not a root startup. */
function startupSessionId(payload) {
  if (!payload) return null;
  if (typeof payload.agent_id === "string" && payload.agent_id) return null;
  if (payload.source !== undefined && payload.source !== "startup") return null;
  return typeof payload.session_id === "string" && SESSION_ID.test(payload.session_id) ? payload.session_id : null;
}

/**
 * Resolves to "skipped" (nothing sent), "bound", "refused" (the monitor answered
 * not ok) or "unavailable" (no answer). The token never appears in the result.
 */
export async function runBindTaskHook({
  provider = "claude",
  stream = process.stdin,
  environment = process.env,
  post,
} = {}) {
  if (!PROVIDERS.has(provider)) return "skipped";
  const token = environment?.[TOKEN_ENVIRONMENT_NAME];
  if (typeof token !== "string" || !TOKEN.test(token)) return "skipped";
  const sessionId = startupSessionId(await readPayload(stream));
  if (!sessionId) return "skipped";
  const send = post ?? createAgentTaskWriter({
    dataRoot: defaultAgentQueryDataRoot(environment),
    timeoutMs: AGENT_QUERY_TIMEOUT_MS,
  });
  try {
    const answer = await send(AGENT_TASK_BIND_PATH, { token, sessionRef: `${provider}:${sessionId}` });
    return answer?.ok === true ? "bound" : "refused";
  } catch {
    return "unavailable";
  }
}

/** `--provider codex` selects Codex; no flag is Claude Code; anything else binds nothing. */
function providerArgument(argv) {
  const index = argv.indexOf("--provider");
  return index === -1 ? "claude" : argv[index + 1] ?? "";
}

async function main() {
  let deadline;
  try {
    await Promise.race([
      runBindTaskHook({ provider: providerArgument(process.argv.slice(2)) }),
      new Promise((resolve) => { deadline = setTimeout(resolve, DEADLINE_MS); }),
    ]);
  } catch { /* A missing link must never disturb the session. */ }
  clearTimeout(deadline);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
