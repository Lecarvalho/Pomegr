import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createIncrementalJsonlIngestor } from "../monitor/providers/incremental-jsonl-ingestor.mjs";
import { incrementalSourceSetDescriptor } from "../monitor/providers/incremental-provider-observer.mjs";

function sourceReader(buffers) {
  return async (offset, bytes, source) => buffers.get(source.identity).subarray(offset, offset + bytes);
}

test("incremental provider framing consumes multi-chunk growth and parses each complete record once", async () => {
  const sources = new Map([["one", Buffer.from('{"id":"a"}\n')]]);
  const published = [];
  let parsed = 0;
  const ingestor = createIncrementalJsonlIngestor({
    readChunk: sourceReader(sources),
    parseRecord: (line) => {
      parsed += 1;
      return JSON.parse(line.toString("utf8"));
    },
    initialState: () => [],
    reduce: (state, record) => [...state, record.id],
    chunkBytes: 5,
    maximumFragmentBytes: 20,
  });
  await ingestor.observe({ identity: "one", size: sources.get("one").length }, (candidate) => published.push(candidate));
  assert.deepEqual(published, [["a"]]);
  sources.set("one", Buffer.from('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n'));
  await ingestor.observe({ identity: "one", size: sources.get("one").length }, (candidate) => published.push(candidate));
  assert.deepEqual(published.at(-1), ["a", "b", "c"]);
  assert.equal(parsed, 3);
  assert.equal(ingestor.snapshot().completeOffset, sources.get("one").length);

  const partial = Buffer.from('{"id":"x"}\n{"id":"y"');
  sources.set("two", partial);
  await ingestor.observe({ identity: "two", size: partial.length }, (candidate, meta) => published.push({ candidate, meta }));
  assert.deepEqual(published.at(-1), ["a", "b", "c"]);
  const completed = Buffer.from('{"id":"x"}\n{"id":"y"}\n');
  sources.set("two", completed);
  await ingestor.observe({ identity: "two", size: completed.length }, (candidate) => published.push(candidate));
  assert.deepEqual(published.at(-1), ["x", "y"]);
  assert.equal(parsed, 5);
});

test("replacement staging never mixes source generations and deterministic reducers retain stronger evidence", async () => {
  const sources = new Map([["old", Buffer.from('{"id":"same","strength":1}\n{"id":"same","strength":3}\n{"id":"same","strength":1}\n')]]);
  const commits = [];
  const ingestor = createIncrementalJsonlIngestor({
    readChunk: sourceReader(sources),
    parseRecord: (line) => JSON.parse(line.toString("utf8")),
    initialState: () => new Map(),
    reduce: (state, record) => {
      const next = new Map(state);
      const previous = next.get(record.id);
      if (!previous || record.strength >= previous.strength) next.set(record.id, record);
      return next;
    },
    chunkBytes: 7,
    maximumFragmentBytes: 28,
  });
  await ingestor.observe({ identity: "old", size: sources.get("old").length }, (candidate, meta) => commits.push({ candidate, meta }));
  assert.equal(commits.at(-1).candidate.get("same").strength, 3);

  sources.set("old", Buffer.from('{"id":"new","strength":2}\n'));
  await ingestor.observe(
    { identity: "old", size: sources.get("old").length },
    (candidate, meta) => commits.push({ candidate, meta }),
  );
  assert.deepEqual([...commits.at(-1).candidate.keys()], ["new"]);
  assert.equal(commits.at(-1).meta.replacement, true);
});

test("a restarted ingestor resumes from the checkpointed complete-record offset", async () => {
  const sources = new Map([["session", Buffer.from('{"id":"a"}\n{"id":"b"}\n')]]);
  const reads = [];
  const create = () => createIncrementalJsonlIngestor({
    readChunk: async (offset, bytes, source) => {
      reads.push(offset);
      return sources.get(source.identity).subarray(offset, offset + bytes);
    },
    parseRecord: (line) => JSON.parse(line.toString("utf8")),
    initialState: () => [],
    reduce: (state, record) => [...state, record.id],
    chunkBytes: 4,
    maximumFragmentBytes: 16,
  });
  const first = create();
  await first.observe({ identity: "session", size: sources.get("session").length }, () => {});
  const checkpoint = first.snapshot();
  const restarted = create();
  assert.equal(restarted.restore({ identity: checkpoint.identity, completeOffset: checkpoint.completeOffset }), true);
  sources.set("session", Buffer.from('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n'));
  reads.length = 0;
  const commits = [];
  await restarted.observe({ identity: "session", size: sources.get("session").length }, (candidate, meta) => commits.push({ candidate, meta }));
  assert.equal(reads[0], checkpoint.completeOffset);
  assert.deepEqual(commits[0].candidate, ["c"]);
  assert.equal(commits[0].meta.completeOffset, sources.get("session").length);
});

test("a child transcript change updates its session source fingerprint without advancing the primary cursor", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-provider-source-set-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary.jsonl");
  const child = path.join(root, "child.jsonl");
  await writeFile(primary, '{"id":"primary"}\n', "utf8");
  await writeFile(child, '{"id":"child"}\n', "utf8");
  const before = incrementalSourceSetDescriptor([primary, child], primary);
  await appendFile(child, '{"id":"child-append"}\n', "utf8");
  const after = incrementalSourceSetDescriptor([primary, child], primary);
  assert.equal(after.size, before.size);
  assert.notEqual(after.identity, before.identity);
});
