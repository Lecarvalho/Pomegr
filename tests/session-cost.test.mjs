import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureClaudeStatuslineCost, readSessionCost } from "../monitor/session-cost.mjs";

test("stores only normalized Claude Code cost metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-cost-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = new Date("2026-08-09T12:00:00.000Z");

  const captured = captureClaudeStatuslineCost({
    session_id: "session-1234",
    cost: { total_cost_usd: 12.3456, private_detail: "must not persist" },
    transcript_path: "C:\\private\\session.jsonl",
    workspace: { current_dir: "C:\\private" },
  }, { root, now });

  assert.deepEqual(captured, {
    version: 1,
    sessionId: "session-1234",
    amount: 12.3456,
    currency: "USD",
    type: "estimated",
    observedAt: now.toISOString(),
  });
  assert.deepEqual(readSessionCost("session-1234", { root }), {
    amount: 12.3456,
    currency: "USD",
    type: "estimated",
    observedAt: now.toISOString(),
  });
  const stored = fs.readFileSync(path.join(root, "session-1234.json"), "utf8");
  assert.doesNotMatch(stored, /private|transcript|workspace/i);
});

test("rejects unsafe or malformed cost snapshots", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-cost-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(captureClaudeStatuslineCost({ session_id: "../escape", cost: { total_cost_usd: 1 } }, { root }), null);
  assert.equal(captureClaudeStatuslineCost({ session_id: "safe", cost: { total_cost_usd: -1 } }, { root }), null);
  assert.equal(captureClaudeStatuslineCost({ session_id: "safe", cost: { total_cost_usd: null } }, { root }), null);
  assert.equal(captureClaudeStatuslineCost({ session_id: "safe", cost: {} }, { root }), null);
  assert.equal(readSessionCost("missing", { root }), null);
});

test("the bridge preserves an existing status-line command", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-cost-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = JSON.stringify({ session_id: "bridge-session", cost: { total_cost_usd: 0.4321 } });
  const bridge = path.resolve("scripts/claude-statusline-bridge.mjs");
  const result = spawnSync(process.execPath, [bridge, "--", process.execPath, "-e", "process.stdin.on('data', value => process.stdout.write(value))"], {
    input,
    encoding: "utf8",
    env: { ...process.env, POMEGR_COST_SNAPSHOTS_DIR: root },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
  assert.equal(readSessionCost("bridge-session", { root })?.amount, 0.4321);
});
