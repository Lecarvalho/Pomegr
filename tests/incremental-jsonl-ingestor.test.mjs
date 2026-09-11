import assert from "node:assert/strict";
import test from "node:test";
import { createIncrementalJsonlIngestor } from "../monitor/providers/incremental-jsonl-ingestor.mjs";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";

test("incremental reads expose only bounded bytes and parsed-record counters when diagnostics are enabled", async () => {
  const source = Buffer.from('{"id":"a"}\n{"id":"b"}\n');
  const run = async (enabled) => {
    const trace = createPipelineTraceRecorder({ enabled });
    const ingestor = createIncrementalJsonlIngestor({
      readChunk: async (offset, bytes) => source.subarray(offset, offset + bytes),
      parseRecord: (line) => JSON.parse(line.toString("utf8")),
      initialState: () => [],
      reduce: (state, record) => [...state, record.id],
      chunkBytes: 5,
      maximumFragmentBytes: 32,
      onCounter(counter, value) {
        trace.recordCounter({ counter, value });
        throw new Error("diagnostics must not block acquisition");
      },
    });
    let published;
    await ingestor.observe({ identity: "synthetic", size: source.length }, (candidate) => { published = candidate; });
    return { published, events: trace.snapshot().traceEvents };
  };

  const disabled = await run(false);
  assert.deepEqual(disabled.published, ["a", "b"]);
  assert.deepEqual(disabled.events, []);

  const enabled = await run(true);
  assert.deepEqual(enabled.published, ["a", "b"]);
  const counters = enabled.events.filter((event) => event.ph === "C");
  assert.equal(counters.filter((event) => event.name === "bytes").length, 1);
  assert.equal(counters.filter((event) => event.name === "records").length, 1);
  assert.equal(counters.filter((event) => event.name === "bytes").reduce((sum, event) => sum + event.args.value, 0), source.length);
  assert.equal(counters.filter((event) => event.name === "records").reduce((sum, event) => sum + event.args.value, 0), 2);
  assert.doesNotMatch(JSON.stringify(enabled), /synthetic|PRIVATE|path|session/i);
});
