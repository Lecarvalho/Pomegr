import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createSessionTitleRenamer,
  normalizeSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
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

test("renames an automatically titled session and preserves any custom title", async () => {
  const calls = [];
  const renameCurrentSession = createSessionTitleRenamer({
    getSessionInfo: async (sessionId, options) => {
      calls.push(["read", sessionId, options]);
      return { sessionId, summary: "Automatic summary" };
    },
    renameSession: async (sessionId, title, options) => calls.push(["rename", sessionId, title, options]),
  });

  assert.deepEqual(await renameCurrentSession({
    sessionId: SESSION_ID,
    directory: PROJECT,
    title: "  Refactor   auth module  ",
  }), { status: "renamed" });
  assert.deepEqual(calls.at(-1), ["rename", SESSION_ID, "Refactor auth module", { dir: PROJECT }]);

  let renamed = false;
  const preserveCurrentTitle = createSessionTitleRenamer({
    getSessionInfo: async () => ({ sessionId: SESSION_ID, customTitle: "User title" }),
    renameSession: async () => { renamed = true; },
  });
  assert.deepEqual(await preserveCurrentTitle({ sessionId: SESSION_ID, directory: PROJECT, title: "Agent title" }), { status: "preserved" });
  assert.equal(renamed, false);
});

test("serializes title requests and releases the session after a failed mutation", async () => {
  let customTitle;
  let renameCalls = 0;
  const renameCurrentSession = createSessionTitleRenamer({
    getSessionInfo: async () => ({ sessionId: SESSION_ID, customTitle }),
    renameSession: async (_sessionId, title) => {
      renameCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      customTitle = title;
    },
  });

  const results = await Promise.all([
    renameCurrentSession({ sessionId: SESSION_ID, directory: PROJECT, title: "First title" }),
    renameCurrentSession({ sessionId: SESSION_ID, directory: PROJECT, title: "Second title" }),
  ]);
  assert.deepEqual(results, [{ status: "renamed" }, { status: "preserved" }]);
  assert.equal(renameCalls, 1);

  let fail = true;
  const recoverable = createSessionTitleRenamer({
    getSessionInfo: async () => ({ sessionId: OTHER_SESSION_ID }),
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

test("trusted rename hook targets only its current main session", async () => {
  const calls = [];
  const dependencies = {
    projectDirectory: PROJECT,
    getSessionInfo: async (sessionId, options) => {
      calls.push(["read", sessionId, options]);
      return { sessionId };
    },
    renameSession: async (sessionId, title, options) => calls.push(["rename", sessionId, title, options]),
  };
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: SESSION_ID,
    cwd: "C:/untrusted/current-directory",
    tool_name: "mcp__plugin_pomegr_pomegr__rename_session",
    tool_input: { title: "Trace title", session_id: OTHER_SESSION_ID, cwd: "C:/forged" },
  };

  assert.deepEqual(await runRenameSessionHook(payload, dependencies), { status: "renamed" });
  assert.deepEqual(calls.at(-1), ["rename", SESSION_ID, "Trace title", { dir: PROJECT }]);

  assert.deepEqual(await runRenameSessionHook({ ...payload, tool_name: "mcp__another__rename_session" }, dependencies), { status: "ignored" });
  assert.deepEqual(await runRenameSessionHook({ ...payload, agent_id: "agent-child" }, dependencies), { status: "unavailable" });
  assert.deepEqual(await runRenameSessionHook({ ...payload, session_id: "not-a-session" }, dependencies), { status: "unavailable" });
});
