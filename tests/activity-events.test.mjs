import assert from "node:assert/strict";
import test from "node:test";
import { userInputContentType } from "../monitor/activity-events.mjs";

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
