import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSessionInfo, InMemorySessionStore, renameSession as nativeRenameSession } from "@anthropic-ai/claude-agent-sdk";

import {
  createSessionTitleRenamer,
  normalizeSessionTitle,
  readExplicitSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
  sessionIdFromTranscriptPath,
  trustedFileIdentityMatches,
} from "../plugins/claude-code/scripts/session-title.mjs";
import { runRenameSessionHook } from "../plugins/claude-code/scripts/rename-session.mjs";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_SESSION_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const PROJECT = path.resolve("C:/synthetic/pomegr-title-test");

async function transcriptFixture(t, records, sessionId = SESSION_ID) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-session-title-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return transcriptPath;
}

test("normalizes bounded plain-text session titles", () => {
  assert.equal(normalizeSessionTitle("  Refactor   auth module  "), "Refactor auth module");
  assert.equal(normalizeSessionTitle(""), null);
  assert.equal(normalizeSessionTitle("line one\nline two"), null);
  assert.equal(normalizeSessionTitle("unsafe \u202etitle"), null);
  assert.equal(normalizeSessionTitle("x".repeat(SESSION_TITLE_MAX_LENGTH + 1)), null);
  assert.equal(normalizeSessionTitle("🍎".repeat(SESSION_TITLE_MAX_LENGTH)), "🍎".repeat(SESSION_TITLE_MAX_LENGTH));
});

test("matches Windows file identities when one stat API omits the device ID", () => {
  assert.equal(trustedFileIdentityMatches({ dev: 12n, ino: 34n }, { dev: 0n, ino: 34n }), true);
  assert.equal(trustedFileIdentityMatches({ dev: 12n, ino: 34n }, { dev: 13n, ino: 34n }), false);
  assert.equal(trustedFileIdentityMatches({ dev: 12n, ino: 34n }, { dev: 12n, ino: 35n }), false);
});

test("reads only genuine custom-title records from the trusted current transcript", async (t) => {
  const automatic = await transcriptFixture(t, [
    { type: "mode", sessionId: SESSION_ID },
    { type: "ai-title", aiTitle: "docs/PLAN.md", sessionId: SESSION_ID },
    { type: "assistant", message: { content: "customTitle must not be mistaken for metadata" } },
  ]);
  assert.equal(sessionIdFromTranscriptPath(automatic), SESSION_ID);
  assert.deepEqual(await readExplicitSessionTitle(automatic, SESSION_ID), { status: "available", title: null });

  const explicit = await transcriptFixture(t, [
    { type: "ai-title", aiTitle: "Automatic summary", sessionId: OTHER_SESSION_ID },
    { type: "custom-title", customTitle: "User title", sessionId: OTHER_SESSION_ID },
  ], OTHER_SESSION_ID);
  assert.deepEqual(await readExplicitSessionTitle(explicit, OTHER_SESSION_ID), { status: "available", title: "User title" });
  assert.deepEqual(await readExplicitSessionTitle(explicit, SESSION_ID), { status: "unavailable", title: null });

  const stale = await transcriptFixture(t, [
    { type: "ai-title", aiTitle: "Current automatic title", sessionId: SESSION_ID },
    { type: "custom-title", customTitle: "Prior session title", sessionId: OTHER_SESSION_ID },
  ]);
  assert.deepEqual(await readExplicitSessionTitle(stale, SESSION_ID), { status: "available", title: null });

  const oversized = await transcriptFixture(t, [{ type: "mode", sessionId: SESSION_ID }]);
  await truncate(oversized, 64 * 1024 * 1024 + 1);
  assert.deepEqual(await readExplicitSessionTitle(oversized, SESSION_ID), { status: "unavailable", title: null });
  assert.equal(sessionIdFromTranscriptPath(path.join(path.dirname(explicit), "agent-child.jsonl")), null);
  assert.equal(sessionIdFromTranscriptPath("relative.jsonl"), null);
});

test("Claude Agent SDK native rename appends a custom title", async () => {
  const sessionStore = new InMemorySessionStore();
  await nativeRenameSession(SESSION_ID, "Native title", { dir: PROJECT, sessionStore });
  const session = await getSessionInfo(SESSION_ID, { dir: PROJECT, sessionStore });
  assert.equal(sessionStore.size, 1);
  assert.equal(session?.customTitle, "Native title");
  assert.equal(session?.summary, "Native title");
});

test("renames an automatically titled session and preserves an explicit title", async () => {
  const calls = [];
  let explicitTitle = null;
  const renameCurrentSession = createSessionTitleRenamer({
    readExplicitTitle: async () => ({ status: "available", title: explicitTitle }),
    renameSession: async (sessionId, title, options) => {
      calls.push(["rename", sessionId, title, options]);
      explicitTitle = title;
    },
  });

  assert.deepEqual(await renameCurrentSession({
    sessionId: SESSION_ID,
    directory: PROJECT,
    transcriptPath: path.join(PROJECT, `${SESSION_ID}.jsonl`),
    title: "  Refactor   auth module  ",
  }), { status: "renamed" });
  assert.deepEqual(calls.at(-1), ["rename", SESSION_ID, "Refactor auth module", { dir: PROJECT }]);

  let renamed = false;
  const preserveCurrentTitle = createSessionTitleRenamer({
    readExplicitTitle: async () => ({ status: "available", title: "User title" }),
    renameSession: async () => { renamed = true; },
  });
  assert.deepEqual(await preserveCurrentTitle({ sessionId: SESSION_ID, directory: PROJECT, transcriptPath: "trusted", title: "Agent title" }), { status: "preserved" });
  assert.equal(renamed, false);
});

test("serializes title requests and releases the session after a failed mutation", async () => {
  let customTitle;
  let renameCalls = 0;
  const renameCurrentSession = createSessionTitleRenamer({
    readExplicitTitle: async () => ({ status: "available", title: customTitle }),
    renameSession: async (_sessionId, title) => {
      renameCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      customTitle = title;
    },
  });

  const results = await Promise.all([
    renameCurrentSession({ sessionId: SESSION_ID, directory: PROJECT, transcriptPath: "trusted", title: "First title" }),
    renameCurrentSession({ sessionId: SESSION_ID, directory: PROJECT, transcriptPath: "trusted", title: "Second title" }),
  ]);
  assert.deepEqual(results, [{ status: "renamed" }, { status: "preserved" }]);
  assert.equal(renameCalls, 1);

  let fail = true;
  const recoverable = createSessionTitleRenamer({
    readExplicitTitle: async () => ({ status: "available", title: null }),
    renameSession: async () => {
      if (fail) {
        fail = false;
        throw new Error("PRIVATE_TRANSCRIPT_PATH_MUST_NOT_LEAK");
      }
    },
  });
  assert.deepEqual(await recoverable({ sessionId: OTHER_SESSION_ID, directory: PROJECT, transcriptPath: "trusted", title: "Retry title" }), { status: "unavailable" });
  assert.deepEqual(await recoverable({ sessionId: OTHER_SESSION_ID, directory: PROJECT, transcriptPath: "trusted", title: "Retry title" }), { status: "renamed" });
});

test("trusted rename hook binds the native mutation to one current main session", async () => {
  const calls = [];
  const dependencies = {
    projectDirectory: PROJECT,
    readExplicitTitle: async (transcriptPath, sessionId) => {
      calls.push(["read", transcriptPath, sessionId]);
      return { status: "available", title: null };
    },
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
