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

test("uses the latest recognized mode without exposing other transcript fields", () => {
  const mode = latestSessionApprovalMode([
    { type: "user", permissionMode: "plan", timestamp: "2026-08-10T16:00:00.000Z" },
    { message: { content: "PRIVATE TOOL RESULT" } },
    { type: "user", permissionMode: "auto", timestamp: "2026-08-10T17:00:00.000Z", cwd: "C:\\private" },
  ]);

  assert.deepEqual(mode, {
    id: "auto",
    label: "Auto mode",
    observedAt: "2026-08-10T17:00:00.000Z",
    source: "provider",
  });
  assert.doesNotMatch(JSON.stringify(mode), /PRIVATE|cwd|message/);
});

test("rejects unknown modes and invalid timestamps", () => {
  assert.equal(sessionApprovalModeFromRecord({ type: "user", permissionMode: "PRIVATE UNKNOWN MODE" }), null);
  assert.equal(sessionApprovalModeFromRecord({ type: "system", permissionMode: "auto" }), null);
  assert.deepEqual(sessionApprovalModeFromRecord({ type: "user", permissionMode: "dontAsk", timestamp: "invalid" }), {
    id: "dont_ask",
    label: "Don't ask",
    observedAt: null,
    source: "provider",
  });
});
