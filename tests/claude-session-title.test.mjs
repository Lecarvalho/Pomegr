import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getSessionInfo, InMemorySessionStore, renameSession as nativeRenameSession } from "@anthropic-ai/claude-agent-sdk";

import {
  createSessionTitleRenamer,
  normalizeSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
  sessionIdFromTranscriptPath,
} from "../plugins/claude-code/scripts/session-title.mjs";
import { runRenameSessionHook } from "../plugins/claude-code/scripts/rename-session.mjs";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_SESSION_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const PROJECT = path.resolve("C:/synthetic/pomegr-title-test");

test("normalizes bounded plain-text session titles", () => {
  assert.equal(normalizeSessionTitle("  Refactor   auth module  "), "Refactor auth module");
  assert.equal(normalizeSessionTitle(""), null);
  assert.equal(normalizeSessionTitle("line one\nline two"), null);
  assert.equal(normalizeSessionTitle("unsafe \u202etitle"), null);
  assert.equal(normalizeSessionTitle("x".repeat(SESSION_TITLE_MAX_LENGTH + 1)), null);
  assert.equal(normalizeSessionTitle("🍎".repeat(SESSION_TITLE_MAX_LENGTH)), "🍎".repeat(SESSION_TITLE_MAX_LENGTH));
});

test("Claude Agent SDK native rename appends a custom title", async () => {
  const sessionStore = new InMemorySessionStore();
  await nativeRenameSession(SESSION_ID, "Native title", { dir: PROJECT, sessionStore });
  const session = await getSessionInfo(SESSION_ID, { dir: PROJECT, sessionStore });
  assert.equal(sessionStore.size, 1);
  assert.equal(session?.customTitle, "Native title");
  assert.equal(session?.summary, "Native title");
});

test("replaces the current title and releases the session after a failed mutation", async () => {
  const calls = [];
  const renameCurrentSession = createSessionTitleRenamer({
    renameSession: async (sessionId, title, options) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push([sessionId, title, options]);
    },
  });

  assert.deepEqual(await renameCurrentSession({ sessionId: SESSION_ID, directory: PROJECT, title: "  Refactor   auth module  " }), { status: "renamed" });
  assert.deepEqual(calls.at(-1), [SESSION_ID, "Refactor auth module", { dir: PROJECT }]);
  assert.deepEqual(await renameCurrentSession({ sessionId: SESSION_ID, directory: PROJECT, title: "unsafe ‮title" }), { status: "rejected" });
  assert.deepEqual(await renameCurrentSession({ sessionId: SESSION_ID, directory: "relative", title: "Title" }), { status: "unavailable" });

  const results = await Promise.all([
    renameCurrentSession({ sessionId: SESSION_ID, directory: PROJECT, title: "First title" }),
    renameCurrentSession({ sessionId: SESSION_ID, directory: PROJECT, title: "Second title" }),
  ]);
  assert.deepEqual(results, [{ status: "renamed" }, { status: "renamed" }]);
  assert.deepEqual(calls.slice(-2).map((call) => call[1]), ["First title", "Second title"]);

  let fail = true;
  const recoverable = createSessionTitleRenamer({
    renameSession: async () => {
      if (fail) {
        fail = false;
        throw new Error("PRIVATE_TRANSCRIPT_PATH_MUST_NOT_LEAK");
      }
    },
  });
  assert.deepEqual(await recoverable({ sessionId: OTHER_SESSION_ID, directory: PROJECT, title: "Retry title" }), { status: "unavailable" });
  assert.deepEqual(await recoverable({ sessionId: OTHER_SESSION_ID, directory: PROJECT, title: "Retry title" }), { status: "renamed" });
});

test("trusted rename hook binds the native mutation to one current main session", async () => {
  assert.equal(sessionIdFromTranscriptPath(path.join(PROJECT, "agent-child.jsonl")), null);
  const calls = [];
  const dependencies = {
    projectDirectory: PROJECT,
    renameSession: async (sessionId, title, options) => calls.push(["rename", sessionId, title, options]),
  };
  const transcriptPath = path.join(PROJECT, `${SESSION_ID}.jsonl`);
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: SESSION_ID,
    transcript_path: transcriptPath,
    cwd: "C:/untrusted/current-directory",
    tool_name: "mcp__plugin_pomegr_pomegr__rename_session",
    tool_input: { title: "Trace title", session_id: OTHER_SESSION_ID, cwd: "C:/forged" },
  };

  assert.deepEqual(await runRenameSessionHook(payload, dependencies), { status: "renamed" });
  assert.deepEqual(calls.at(-1), ["rename", SESSION_ID, "Trace title", { dir: PROJECT }]);

  assert.deepEqual(await runRenameSessionHook({ ...payload, tool_name: "mcp__another__rename_session" }, dependencies), { status: "ignored" });
  assert.deepEqual(await runRenameSessionHook({ ...payload, agent_id: "agent-child" }, dependencies), { status: "unavailable" });
  assert.deepEqual(await runRenameSessionHook({ ...payload, session_id: "not-a-session" }, dependencies), { status: "unavailable" });
  assert.deepEqual(await runRenameSessionHook({ ...payload, transcript_path: path.join(PROJECT, `${OTHER_SESSION_ID}.jsonl`) }, dependencies), { status: "unavailable" });
  assert.deepEqual(await runRenameSessionHook({ ...payload, transcript_path: "relative.jsonl" }, dependencies), { status: "unavailable" });
});
