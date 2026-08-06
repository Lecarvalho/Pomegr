import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSessionTask } from "../monitor/session-tasks.mjs";

test("normalizes only the plan fields allowed in the browser API", () => {
  const task = normalizeSessionTask({
    id: "6",
    subject: "  Apply   approved workflow changes  ",
    description: "PRIVATE LONG-FORM TASK DESCRIPTION",
    activeForm: "PRIVATE ACTIVE FORM",
    status: "in_progress",
    blocks: ["7", "7", "invalid id"],
    blockedBy: ["2"],
  });

  assert.deepEqual(task, {
    id: "6",
    subject: "Apply approved workflow changes",
    status: "in_progress",
    blocks: ["7"],
    blockedBy: ["2"],
  });
  assert.doesNotMatch(JSON.stringify(task), /PRIVATE|description|activeForm/);
});

test("rejects plan items without a safe identity and subject", () => {
  assert.equal(normalizeSessionTask({ id: "../escape", subject: "Unsafe" }), null);
  assert.equal(normalizeSessionTask({ id: "1", subject: "   " }), null);
});
