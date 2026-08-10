import assert from "node:assert/strict";
import test from "node:test";
import { latestSessionApprovalMode, sessionApprovalModeFromRecord } from "../monitor/session-approval-mode.mjs";

test("normalizes recognized provider approval modes", () => {
  assert.deepEqual(sessionApprovalModeFromRecord({
    type: "user",
    permissionMode: "acceptEdits",
    timestamp: "2026-08-10T17:00:09.626Z",
    message: { content: "PRIVATE PROMPT" },
  }), {
    id: "accept_edits",
    label: "Accept edits",
    observedAt: "2026-08-10T17:00:09.626Z",
    source: "provider",
  });
});

test("normalizes current permission-mode records without inventing a timestamp", () => {
  assert.deepEqual(sessionApprovalModeFromRecord({
    type: "permission-mode",
    permissionMode: "auto",
    sessionId: "PRIVATE SESSION ID",
  }), {
    id: "auto",
    label: "Auto mode",
    observedAt: null,
    source: "provider",
  });
});

test("uses the latest recognized mode without exposing other transcript fields", () => {
  const mode = latestSessionApprovalMode([
    { type: "user", permissionMode: "plan", timestamp: "2026-08-10T16:00:00.000Z" },
    { message: { content: "PRIVATE TOOL RESULT" } },
    { type: "permission-mode", permissionMode: "acceptEdits", sessionId: "PRIVATE SESSION ID" },
  ]);

  assert.deepEqual(mode, {
    id: "accept_edits",
    label: "Accept edits",
    observedAt: null,
    source: "provider",
  });
  assert.doesNotMatch(JSON.stringify(mode), /PRIVATE|sessionId|message/);
});

test("rejects unknown modes and invalid timestamps", () => {
  assert.equal(sessionApprovalModeFromRecord({ type: "user", permissionMode: "PRIVATE UNKNOWN MODE" }), null);
  assert.equal(sessionApprovalModeFromRecord({ type: "system", permissionMode: "auto" }), null);
  assert.deepEqual(sessionApprovalModeFromRecord({ type: "permission-mode", permissionMode: "manual" }), {
    id: "manual",
    label: "Manual mode",
    observedAt: null,
    source: "provider",
  });
  assert.deepEqual(sessionApprovalModeFromRecord({ type: "user", permissionMode: "dontAsk", timestamp: "invalid" }), {
    id: "dont_ask",
    label: "Don't ask",
    observedAt: null,
    source: "provider",
  });
});
