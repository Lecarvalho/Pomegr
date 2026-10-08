import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createSourceWriteClassifier } from "../../../../server/providers/kernel/source-write-classifier.mjs";

const START = 1_000_000;
const target = path.resolve("synthetic-sources");

function classifier(files, options = {}) {
  return createSourceWriteClassifier({
    now: () => START,
    async stat(file) {
      const info = files.get(path.basename(file));
      if (!info) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { size: info.size, mtimeMs: info.mtimeMs, isFile: () => info.directory !== true };
    },
    ...options,
  });
}
const change = (filename) => ({ target, filename, eventType: "change" });

test("a first notification is a write only when the file was modified after the classifier started", async () => {
  const files = new Map([
    ["old.jsonl", { size: 10, mtimeMs: START - 3_600_000 }],
    ["new.jsonl", { size: 10, mtimeMs: START + 5 }],
    ["just-before.jsonl", { size: 10, mtimeMs: START - 1_500 }],
  ]);
  const writes = classifier(files);
  assert.equal(await writes.classify(change("old.jsonl")), "unchanged");
  assert.equal(await writes.classify(change("new.jsonl")), "written");
  assert.equal(await writes.classify(change("just-before.jsonl")), "written");
});

test("a later notification is a write only when size or modification time moved", async () => {
  const files = new Map([["one.jsonl", { size: 10, mtimeMs: START - 3_600_000 }]]);
  const writes = classifier(files);
  assert.equal(await writes.classify(change("one.jsonl")), "unchanged");
  assert.equal(await writes.classify(change("one.jsonl")), "unchanged", "a repeated access-only notification");
  files.set("one.jsonl", { size: 25, mtimeMs: START - 3_600_000 });
  assert.equal(await writes.classify(change("one.jsonl")), "written", "growth with an unmoved modification time");
  files.set("one.jsonl", { size: 25, mtimeMs: START + 10 });
  assert.equal(await writes.classify(change("one.jsonl")), "written", "a rewrite at the same size");
  assert.equal(await writes.classify(change("one.jsonl")), "unchanged", "the second notification of one write");
});

test("anything that is not a change to a readable regular file is left unverified", async () => {
  const files = new Map([
    ["one.jsonl", { size: 10, mtimeMs: START - 3_600_000 }],
    ["folder", { size: 0, mtimeMs: START - 3_600_000, directory: true }],
  ]);
  const writes = classifier(files);
  assert.equal(await writes.classify({ target, filename: "one.jsonl", eventType: "rename" }), "unverified");
  assert.equal(await writes.classify({ target, filename: null, eventType: "change" }), "unverified");
  assert.equal(await writes.classify(change("missing.jsonl")), "unverified");
  assert.equal(await writes.classify(change("folder")), "unverified");
  assert.equal(await writes.classify(), "unverified");
});

test("the tracked set is bounded and forgets the least recently notified file", async () => {
  const files = new Map(["a", "b", "c"].map((name) => [name, { size: 1, mtimeMs: START + 1 }]));
  const writes = classifier(files, { maxEntries: 2 });
  for (const name of ["a", "b", "c"]) assert.equal(await writes.classify(change(name)), "written");
  assert.equal(await writes.classify(change("b")), "unchanged", "still tracked");
  assert.equal(await writes.classify(change("a")), "written", "forgotten, so judged again as a first notification");
});
