import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { footprintFromRecord, readFirstRequestFootprint } from "../monitor/first-request-footprint.mjs";

test("normalizes a provider usage record without retaining message content", () => {
  const footprint = footprintFromRecord({
    type: "assistant",
    timestamp: "2026-08-06T12:00:00.000Z",
    message: {
      content: [{ type: "text", text: "PRIVATE RESPONSE" }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 700,
        output_tokens: 25,
      },
    },
  });

  assert.deepEqual(footprint, {
    observedAt: "2026-08-06T12:00:00.000Z",
    input: 1_002,
    uncachedInput: 2,
    cacheWrite: 300,
    cacheRead: 700,
    output: 25,
  });
  assert.doesNotMatch(JSON.stringify(footprint), /PRIVATE RESPONSE/);
  assert.equal(footprintFromRecord({ type: "assistant", message: { usage: { output_tokens: 5 } } }), null);
});

test("reads the earliest non-zero footprint from the transcript head", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-first-request-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  await writeFile(file, [
    "not-json",
    JSON.stringify({ type: "user", message: { content: "PRIVATE PROMPT" } }),
    JSON.stringify({ type: "assistant", message: { usage: {} } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-06T12:00:01.000Z", message: { usage: { input_tokens: 1, cache_read_input_tokens: 999, output_tokens: 10 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-06T12:01:00.000Z", message: { usage: { input_tokens: 2_000 } } }),
  ].join("\n"), "utf8");

  assert.deepEqual(await readFirstRequestFootprint(file), {
    observedAt: "2026-08-06T12:00:01.000Z",
    input: 1_000,
    uncachedInput: 1,
    cacheWrite: 0,
    cacheRead: 999,
    output: 10,
  });
});
