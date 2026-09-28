import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_LIVENESS_MAX_OWNER_TAIL_BYTES,
  CODEX_LIVENESS_MAX_TAIL_BYTES,
  createCodexLivenessCoordinator,
} from "../monitor/providers/codex-liveness.mjs";

// Owner-confirmed header scans, split from codex-liveness.test.mjs to keep both
// files under the architecture line limits.
const START = Date.parse("2026-08-11T12:00:00.000Z");

function boundary(offset, type = "task_complete", turnId = "backlogged-turn") {
  return { timestamp: new Date(START + offset).toISOString(), type: "event_msg", payload: { type, turn_id: turnId } };
}

function thread(localId = "live-root", options = {}) {
  return {
    localId,
    sessionId: options.sessionId || localId,
    parentThreadId: options.parentThreadId || null,
    sourceKind: options.sourceKind || (options.parentThreadId ? "subAgentThreadSpawn" : "cli"),
    updatedAt: options.updatedAt || new Date(START).toISOString(),
    runtimeStatus: options.runtimeStatus || null,
    rolloutFile: options.rolloutFile || null,
  };
}

test("confirmed native ownership gets a bounded deeper header scan for an explicit live turn", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-owner-header-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout.jsonl");
  const records = [boundary(0, "task_started", "owner-turn")];
  for (let index = 0; index < 300; index += 1) records.push({
    timestamp: new Date(START + 1_000).toISOString(),
    type: "event_msg",
    payload: { type: "unrecognized_noise", padding: "x".repeat(1_024) },
  });
  await writeFile(rolloutFile, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  const size = fs.statSync(rolloutFile).size;
  assert.equal(size > CODEX_LIVENESS_MAX_TAIL_BYTES, true);
  assert.equal(size < CODEX_LIVENESS_MAX_OWNER_TAIL_BYTES, true);
  const candidate = thread("owner-header-root", {
    rolloutFile,
    updatedAt: new Date(START + 2_000).toISOString(),
  });

  const ordinary = createCodexLivenessCoordinator({
    now: () => START + 2_000,
    cacheMs: 0,
  }).observe([candidate]);
  assert.equal(ordinary.sessions.get("owner-header-root").activityStatus, "unknown");

  const owner = createCodexLivenessCoordinator({
    now: () => START + 2_000,
    cacheMs: 0,
    currentWriterOwner: () => ({ pid: 4242, processStartIdentity: "134000000000000000" }),
  }).observe([candidate]);
  assert.equal(owner.threads[0].presenceConfirmed, true);
  assert.equal(owner.threads[0].liveness.source, "structured_lifecycle");
  assert.equal(owner.threads[0].liveness.evidence, "observed");
  assert.equal(owner.sessions.get("owner-header-root").activityStatus, "working");
  assert.equal(owner.sessions.get("owner-header-root").isLive, true);
  assert.equal(owner.threads[0].liveness.observedAt, new Date(START).toISOString());
});

test("confirmed native ownership plus fresh structured activity refines a boundaryless tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-owner-activity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout.jsonl");
  const records = [boundary(0, "task_started", "outside-tail")];
  for (let index = 0; index < 180; index += 1) records.push({
    timestamp: new Date(START + 1_000).toISOString(),
    type: "unrecognized_record",
    payload: { padding: "x".repeat(1_024) },
  });
  const activityAt = new Date(START + 2_000).toISOString();
  records.push({
    timestamp: activityAt,
    type: "response_item",
    payload: { type: "function_call", name: "exec", call_id: "fresh-tool" },
  });
  await writeFile(rolloutFile, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  assert.equal(fs.statSync(rolloutFile).size > CODEX_LIVENESS_MAX_TAIL_BYTES, true);
  const candidate = thread("owner-activity-root", {
    rolloutFile,
    updatedAt: activityAt,
  });
  const base = {
    now: () => START + 3_000,
    cacheMs: 0,
    maximumOwnerTailBytes: CODEX_LIVENESS_MAX_TAIL_BYTES,
  };

  const ordinary = createCodexLivenessCoordinator(base).observe([candidate]);
  assert.equal(ordinary.sessions.get("owner-activity-root").activityStatus, "unknown");

  const owner = createCodexLivenessCoordinator({
    ...base,
    currentWriterOwner: () => ({ pid: 4242, processStartIdentity: "134000000000000000" }),
  }).observe([candidate]);
  assert.equal(owner.threads[0].presenceConfirmed, true);
  assert.equal(owner.threads[0].liveness.source, "rollout_activity_heuristic");
  assert.equal(owner.threads[0].liveness.evidence, "inferred");
  assert.equal(owner.threads[0].liveness.observedAt, activityAt);
  assert.equal(owner.sessions.get("owner-activity-root").activityStatus, "working");
});
