import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeSessionRegistryEntry, preferredRegisteredSessionId, readSessionRegistry } from "../monitor/session-registry.mjs";

test("classifies only explicit user-attention waits as needing input", () => {
  const input = normalizeSessionRegistryEntry({
    sessionId: "session-input",
    status: "waiting",
    waitingFor: "input needed",
    statusUpdatedAt: 1_786_000_000_000,
  });
  const background = normalizeSessionRegistryEntry({
    sessionId: "session-background",
    status: "waiting",
    waitingFor: "background tasks",
    statusUpdatedAt: 1_786_000_000_001,
  });

  assert.equal(input.needsInput, true);
  assert.equal(background.needsInput, false);
  assert.equal(input.waitingFor, undefined);
});

test("prioritizes an input wait over newer active registry sessions", () => {
  const registry = new Map([
    ["newer-active", { status: "active", needsInput: false }],
    ["older-question", { status: "waiting", needsInput: true }],
  ]);

  assert.equal(
    preferredRegisteredSessionId(registry, ["newer-active", "older-question"]),
    "older-question",
  );
});

test("reads valid registry entries and ignores malformed files independently", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "valid.json"), JSON.stringify({
    sessionId: "live-session",
    status: "waiting",
    waitingFor: "permission needed",
    updatedAt: 1_786_000_000_000,
  }));
  await writeFile(path.join(root, "partial.json"), "{");
  await writeFile(path.join(root, "unsafe.json"), JSON.stringify({ sessionId: "../unsafe", status: "waiting", waitingFor: "input" }));

  const registry = readSessionRegistry(root);
  assert.equal(registry.size, 1);
  assert.equal(registry.get("live-session").needsInput, true);
});
