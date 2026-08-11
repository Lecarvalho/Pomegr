import test from "node:test";
import assert from "node:assert/strict";
import { concurrentMutationOverlaps, mutationScopes, repetitionSignature } from "../monitor/tool-efficiency.mjs";

test("repetition signatures distinguish edit regions and grep windows", () => {
  const firstEdit = repetitionSignature("Edit", { file_path: "handler.cs", old_string: "first", new_string: "updated first" });
  const secondEdit = repetitionSignature("Edit", { file_path: "handler.cs", old_string: "second", new_string: "updated second" });
  assert.notEqual(firstEdit, secondEdit);

  const firstSearch = repetitionSignature("Grep", { path: "backend", pattern: "screenplay", offset: 0 });
  const nextSearch = repetitionSignature("Grep", { path: "backend", pattern: "screenplay", offset: 50 });
  assert.notEqual(firstSearch, nextSearch);
  assert.equal(firstSearch, repetitionSignature("Grep", { offset: 0, pattern: "screenplay", path: "backend" }));
});

test("overlap requires concurrent mutations to the same scope", () => {
  const shared = mutationScopes("Edit", { file_path: "handler.cs", old_string: "same region" });
  const other = mutationScopes("Edit", { file_path: "handler.cs", old_string: "other region" });
  const overlaps = concurrentMutationOverlaps([
    { actorId: "one", timestamp: "2026-08-05T12:00:00Z", display: "handler.cs", scopes: shared },
    { actorId: "two", timestamp: "2026-08-05T12:00:20Z", display: "handler.cs", scopes: other },
    { actorId: "two", timestamp: "2026-08-05T12:01:00Z", display: "handler.cs", scopes: shared },
  ]);
  assert.deepEqual(overlaps, []);

  const collision = concurrentMutationOverlaps([
    { actorId: "one", timestamp: "2026-08-05T12:00:00Z", display: "handler.cs", scopes: shared },
    { actorId: "two", timestamp: "2026-08-05T12:00:20Z", display: "handler.cs", scopes: shared },
  ]);
  assert.equal(collision.length, 1);
  assert.equal(collision[0].actors.size, 2);
});

test("reads and searches do not create mutation scopes", () => {
  assert.deepEqual(mutationScopes("Read", { file_path: "handler.cs", offset: 0 }), []);
  assert.deepEqual(mutationScopes("Grep", { path: "backend", pattern: "screenplay" }), []);
});

test("Codex patch and file-change mutations keep paths and anchors monitor-side", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/handler.ts",
    "@@ first anchor @@",
    "-private old value",
    "+private new value",
    "*** Add File: src/new.ts",
    "+private content",
    "*** End Patch",
  ].join("\n");
  const patchScopes = mutationScopes("apply_patch", { patch });
  assert.equal(patchScopes.length, 2);
  assert.match(patchScopes[0], /src[\\/]handler\.ts:anchor:[a-f0-9]{16}$/);
  assert.match(patchScopes[1], /src[\\/]new\.ts:whole-file$/);

  const changes = mutationScopes("fileChange", { changes: [
    { path: "src/handler.ts", kind: { type: "update" }, diff: "@@ second anchor @@\n-private\n+private" },
    { path: "src/moved.ts", kind: { type: "update", move_path: "src/final.ts" }, diff: "@@ move @@\n-private\n+private" },
  ] });
  assert.equal(changes.length, 3);
  assert.notEqual(changes[0], patchScopes[0]);
  assert.match(changes[2], /src[\\/]final\.ts:whole-file$/);
});
