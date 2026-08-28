import assert from "node:assert/strict";
import test from "node:test";
import { recentActivityEvents, shellFailureActivityEvents, userInputContentType } from "../monitor/activity-events.mjs";

test("classifies direct user input without exposing its content", () => {
  assert.equal(userInputContentType({ type: "user", message: { content: "PRIVATE PROMPT" } }), "Text");
  assert.equal(userInputContentType({ type: "user", message: { content: [{ type: "image", source: { media_type: "image/png", data: "PRIVATE IMAGE" } }] } }), "Image");
  assert.equal(userInputContentType({ type: "user", message: { content: [{ type: "document", source: { media_type: "application/pdf", data: "PRIVATE DOCUMENT" } }] } }), "Document");
  assert.equal(userInputContentType({ type: "user", isMeta: true, message: { content: "INTERNAL META" } }), null);
  assert.equal(userInputContentType({ type: "assistant", message: { content: "NOT USER INPUT" } }), null);
});

test("recognizes answers to input requests but excludes ordinary tool results", () => {
  const answer = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "question-1", content: "PRIVATE ANSWER" }] } };
  assert.equal(userInputContentType(answer, new Set(["question-1"])), "Text");
  assert.equal(userInputContentType(answer, new Set(["shell-1"])), null);
});

test("uses a stable order for every content-type combination", () => {
  const blocks = {
    text: { type: "text", text: "PRIVATE TEXT" },
    document: { type: "document", source: { media_type: "application/pdf", data: "PRIVATE DOCUMENT" } },
    image: { type: "image", source: { media_type: "image/jpeg", data: "PRIVATE IMAGE" } },
  };
  const classify = (...kinds) => userInputContentType({ type: "user", message: { content: kinds.map((kind) => blocks[kind]) } });

  assert.equal(classify("text", "document"), "Text + Document");
  assert.equal(classify("document", "image"), "Document + Image");
  assert.equal(classify("text", "document", "image"), "Text + Document + Image");
  assert.equal(classify("text", "image"), "Text + Image");
});

test("creates sanitized activity events only for finished shell failures", () => {
  const events = shellFailureActivityEvents([
    { id: "toolu_failed", label: "Run tests", status: "failed", finishedAt: "2026-08-07T14:32:00.000Z", exitCode: 1, command: "PRIVATE COMMAND", output: "PRIVATE OUTPUT" },
    { id: "toolu_unknown", label: "Check formatting", status: "failed", finishedAt: "2026-08-07T14:33:00.000Z", exitCode: null },
    { id: "toolu_running", label: "Build app", status: "running", finishedAt: null, exitCode: null },
    { id: "toolu_complete", label: "Lint app", status: "completed", finishedAt: "2026-08-07T14:34:00.000Z", exitCode: 0 },
  ]);

  assert.deepEqual(events, [
    {
      id: "toolu_failed-failed",
      timestamp: "2026-08-07T14:32:00.000Z",
      actor: "Primary agent",
      tool: "Shell failed",
      workKind: "shell",
      detail: "Run tests · exit 1",
      status: "failed",
    },
    {
      id: "toolu_unknown-failed",
      timestamp: "2026-08-07T14:33:00.000Z",
      actor: "Primary agent",
      tool: "Shell failed",
      workKind: "shell",
      detail: "Check formatting",
      status: "failed",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|command|output/i);
});

test("bounds recent activity and resolves timestamp ties deterministically", () => {
  const events = Array.from({ length: 35 }, (_, index) => ({
    id: `event-${String(34 - index).padStart(2, "0")}`,
    timestamp: index < 2 ? "2026-08-10T15:00:35.000Z" : `2026-08-10T15:00:${String(index).padStart(2, "0")}.000Z`,
    actor: "Primary agent",
    tool: "Tool",
    detail: "Safe detail",
    status: index === 34 ? "failed" : "completed",
  }));
  const recent = recentActivityEvents(events);
  assert.equal(recent.length, 30);
  assert.deepEqual(recent.slice(0, 2).map((event) => event.id), ["event-33", "event-34"]);
  assert.equal(recent.every((event) => event.status === null || event.status === "failed"), true);
});
