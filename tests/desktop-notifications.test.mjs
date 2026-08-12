import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedNotificationTitle,
  createNeedsInputNotificationController,
  isSafeNotificationSessionId,
  NEEDS_INPUT_NOTIFICATION_COPY,
} from "../desktop/notifications.mjs";

function session(id, options = {}) {
  return {
    id,
    title: options.title ?? "Safe session title",
    isLive: options.isLive ?? true,
    needsInput: options.needsInput ?? false,
    ...options.privateFields,
  };
}

function harness(now = () => Date.parse("2026-08-12T12:00:00.000Z")) {
  const notifications = [];
  const opened = [];
  const controller = createNeedsInputNotificationController({
    now,
    notify(payload, onClick) { notifications.push({ payload, onClick }); },
    openSession(id) { opened.push(id); },
  });
  return { controller, notifications, opened };
}

test("one needs-input transition emits at most once until it resolves", () => {
  const { controller, notifications } = harness();
  const idle = session("claude:session-1");
  const waiting = session("claude:session-1", { needsInput: true });

  assert.equal(controller.observe([idle], { enabled: true }), 0);
  assert.equal(controller.observe([waiting], { enabled: true }), 1);
  assert.equal(controller.observe([waiting], { enabled: true }), 0);
  assert.equal(notifications.length, 1);

  assert.equal(controller.observe([idle], { enabled: true }), 0);
  assert.equal(controller.observe([waiting], { enabled: true }), 1);
  assert.equal(notifications.length, 2);
});

test("resolved, nonlive, missing, and expired heuristic snapshots clear deterministically", () => {
  const { controller, notifications } = harness();
  const waiting = session("codex:thread-1", { needsInput: true });
  controller.observe([waiting], { enabled: true });
  controller.observe([session("codex:thread-1", { needsInput: false })], { enabled: true });
  controller.observe([waiting], { enabled: true });
  controller.observe([session("codex:thread-1", { isLive: false, needsInput: true })], { enabled: true });
  controller.observe([waiting], { enabled: true });
  controller.observe([], { enabled: true });
  controller.observe([waiting], { enabled: true });
  assert.equal(notifications.length, 4);
});

test("disabled and quiet observations consume transitions without delayed notifications", () => {
  let nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  const { controller, notifications } = harness(() => nowMs);
  const first = session("claude:quiet-1", { needsInput: true });
  controller.observe([first], { enabled: false });
  controller.observe([first], { enabled: true });
  assert.equal(notifications.length, 0);

  controller.observe([], { enabled: true });
  controller.observe([first], { enabled: true, quietUntil: "2026-08-12T13:00:00.000Z" });
  nowMs = Date.parse("2026-08-12T13:00:01.000Z");
  controller.observe([first], { enabled: true, quietUntil: "2026-08-12T13:00:00.000Z" });
  assert.equal(notifications.length, 0);

  controller.observe([], { enabled: true });
  controller.observe([first], { enabled: true });
  assert.equal(notifications.length, 1);
});

test("native payload is fixed, bounded, and excludes every private sentinel", () => {
  const { controller, notifications, opened } = harness();
  const privateFields = {
    question: "QUESTION_MUST_NOT_LEAK",
    choices: ["CHOICE_MUST_NOT_LEAK"],
    prompt: "PROMPT_MUST_NOT_LEAK",
    command: "COMMAND_MUST_NOT_LEAK",
    toolInput: "TOOL_INPUT_MUST_NOT_LEAK",
    repositoryFileContent: "FILE_CONTENT_MUST_NOT_LEAK",
    stdout: "STDOUT_MUST_NOT_LEAK",
    stderr: "STDERR_MUST_NOT_LEAK",
    approvalDetails: "APPROVAL_MUST_NOT_LEAK",
  };
  controller.observe([session("codex:safe-id", { needsInput: true, title: "  Safe\nnormalized\ttitle  ", privateFields })], { enabled: true });

  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0].payload, {
    title: "Threadlight",
    body: NEEDS_INPUT_NOTIFICATION_COPY,
  });
  assert.doesNotMatch(JSON.stringify(notifications[0].payload), /QUESTION|CHOICE|PROMPT|COMMAND|TOOL_INPUT|FILE_CONTENT|STDOUT|STDERR|APPROVAL/);
  notifications[0].onClick();
  assert.deepEqual(opened, ["codex:safe-id"]);
});

test("unsafe IDs are ignored and notification titles remain one bounded line", () => {
  const { controller, notifications } = harness();
  for (const id of ["codex:../private", "codex:C:\\private", "codex:thread:child", "unknown", ""] ) {
    assert.equal(isSafeNotificationSessionId(id), false);
  }
  controller.observe([session("codex:../private", { needsInput: true })], { enabled: true });
  assert.equal(notifications.length, 0);
  const bounded = boundedNotificationTitle(`\u0000 ${"x".repeat(200)}\nprivate`);
  assert.equal(bounded.length, 96);
  assert.doesNotMatch(bounded, /[\r\n\u0000]/);
});

test("session-title privacy sentinels never enter the native notification payload", () => {
  const { controller, notifications } = harness();
  controller.observe([session("codex:safe-id", {
    needsInput: true,
    title: "PROMPT_MUST_NOT_LEAK CREDENTIAL_MUST_NOT_LEAK C:\\Users\\private",
  })], { enabled: true });
  assert.deepEqual(notifications[0].payload, {
    title: "Threadlight",
    body: NEEDS_INPUT_NOTIFICATION_COPY,
  });
  assert.doesNotMatch(JSON.stringify(notifications[0].payload), /MUST_NOT_LEAK|C:\\\\Users/);
});
