import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

import { handleUsageGuard, USAGE_GUARD_MAX_CONTEXT_BYTES, USAGE_GUARD_MAX_INPUT_BYTES } from "../scripts/usage-guard.mjs";
import { guardHash, readUsageGuardConfig } from "../scripts/usage-guard-state.mjs";
import { evaluateUsageGuard, normalizeUsageGuardConfig, usageGuardNotice, USAGE_GUARD_DEFAULTS } from "../shared/usage-guard-policy.mjs";
import { AGENT_QUERY_AUTH_HEADER, createAgentQueryCapability, publishAgentQueryDescriptor } from "../shared/agent-query-transport.mjs";

const now = Date.parse("2026-09-06T14:00:00Z");
const iso = (at) => new Date(at).toISOString();
const config = normalizeUsageGuardConfig({ version: 1, mode: "advisory" });

function snapshot(percent, { at = now, working = 1, live = working, unknown = 0, provider = "claude" } = {}) {
  return {
    schemaVersion: 1,
    providers: [{
      provider, readiness: "ready", available: true, freshness: "fresh", observedAt: iso(at),
      localActivity: { scope: "machine_provider", readiness: "ready", observedAt: iso(at), liveSessions: live, workingSessions: working, unknownSessions: unknown, truncated: false },
      windows: [
        { id: provider === "claude" ? "current-session" : "codex-primary", usedPercent: percent, resetsAt: iso(at + 3_600_000), active: percent >= 100 },
        { id: provider === "claude" ? "all-models" : "codex-secondary", usedPercent: 10, resetsAt: iso(at + 86_400_000), active: false },
      ],
    }],
  };
}

async function fixture(t, customConfig = config) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-usage-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".pomegr"));
  await writeFile(path.join(root, ".pomegr", "usage-guard.json"), JSON.stringify(customConfig));
  return { root, dataRoot: path.join(root, "data"), event: { hook_event_name: "PostToolUse", session_id: "test-session", cwd: root } };
}

test("configuration requires explicit advisory opt-in and rejects unsupported control/settings", () => {
  assert.deepEqual(config, USAGE_GUARD_DEFAULTS);
  for (const value of [null, {}, { version: 1 }, { ...config, mode: "pause" }, { ...config, command: "private" },
    { ...config, warnAt: 90 }, { ...config, checkIntervalSeconds: 30 }, { ...config, version: 2 },
    { ...config, maxConcurrencyReservePercent: 25 }]) assert.equal(normalizeUsageGuardConfig(value), null);
  assert.equal(normalizeUsageGuardConfig({ version: 1, mode: "off" }).mode, "off");
});

test("working concurrency moves reserve thresholds, not account percentage; idle/unknown are separate", () => {
  const single = evaluateUsageGuard(snapshot(66), "claude", config, now);
  assert.equal(single.stage, "normal");
  const two = evaluateUsageGuard(snapshot(66, { working: 2, live: 9, unknown: 1 }), "claude", config, now);
  assert.equal(two.stage, "warn");
  assert.equal(two.usedPercent, 66);
  assert.deepEqual(two.thresholds, { warn: 65, handoff: 75, stop: 85 });
  assert.equal(evaluateUsageGuard(snapshot(66, { working: 1, live: 9, unknown: 2 }), "claude", config, now).stage, "normal");
  assert.equal(evaluateUsageGuard(snapshot(76, { working: 100 }), "claude", config, now).stage, "stop");
  assert.equal(evaluateUsageGuard(snapshot(76, { working: 100 }), "claude", config, now).reserve, 15);
});

test("weekly capacity, missing windows, passed resets, and original age retain their semantics", () => {
  const weekly = snapshot(4);
  weekly.providers[0].windows[1].usedPercent = 82;
  assert.equal(evaluateUsageGuard(weekly, "claude", config, now).stage, "handoff");
  assert.equal(evaluateUsageGuard(weekly, "claude", config, now).kind, "weekly");
  for (const change of [
    (entry) => { entry.observedAt = iso(now - 300_001); },
    (entry) => { entry.observedAt = iso(now + 1); },
    (entry) => { entry.freshness = "stale"; },
    (entry) => { entry.available = false; },
    (entry) => { entry.windows[0].resetsAt = iso(now); },
    (entry) => { entry.windows[0].usedPercent = null; },
    (entry) => { entry.windows.pop(); },
    (entry) => { entry.windows.push(entry.windows[0]); },
  ]) {
    const value = snapshot(3);
    change(value.providers[0]);
    assert.equal(evaluateUsageGuard(value, "claude", config, now).stage, "unknown");
  }
  const partialHigh = snapshot(84);
  partialHigh.providers[0].windows.pop();
  assert.equal(evaluateUsageGuard(partialHigh, "claude", config, now).stage, "handoff");
  assert.equal(evaluateUsageGuard(partialHigh, "claude", config, now).incomplete, true);
});

test("catalog age and malformed counts cannot claim fresh concurrency", () => {
  for (const patch of [
    { observedAt: iso(now - 300_001) }, { observedAt: iso(now + 1) }, { readiness: "loading" },
    { workingSessions: 5 }, { liveSessions: 10_001 }, { unknownSessions: -1 }, { scope: "account" },
  ]) {
    const value = snapshot(66);
    Object.assign(value.providers[0].localActivity, patch);
    const decision = evaluateUsageGuard(value, "claude", config, now);
    assert.equal(decision.activity, null);
    assert.equal(decision.reserve, 0);
  }
});

test("model-specific evidence never requests a global pause without model applicability", () => {
  const value = snapshot(3);
  value.providers[0].windows.push({ id: "model-fable", usedPercent: 100, active: true, resetsAt: iso(now + 86_400_000) });
  const decision = evaluateUsageGuard(value, "claude", config, now);
  assert.equal(decision.stage, "model_warning");
  assert.match(usageGuardNotice(decision, "claude"), /may not apply to your current model/);
});

test("low usage performs at most one cached query per interval and emits no model context", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let percent = 3;
  const query = async (route, args) => {
    assert.equal(route, "/api/agent/v1/usage-limits");
    assert.deepEqual(args, { provider: "claude" });
    calls += 1;
    return snapshot(percent);
  };
  const options = { dataRoot: f.dataRoot, provider: "claude", now, query };
  assert.equal(await handleUsageGuard(f.event, options), null);
  for (let second = 1; second < 60; second++) {
    assert.equal(await handleUsageGuard(f.event, { ...options, now: now + second * 1000 }), null);
  }
  assert.equal(calls, 1);
  percent = 6;
  assert.equal(await handleUsageGuard(f.event, { ...options, now: now + 60_000 }), null);
  assert.equal(calls, 2);
});

test("warn, handoff, and voluntary stop emit only transitions; no hook ever controls the agent", async (t) => {
  const f = await fixture(t);
  let percent = 71;
  let at = now;
  const options = { dataRoot: f.dataRoot, provider: "claude", query: async () => snapshot(percent, { at }) };
  for (const [next, expected] of [[71, "warn"], [75, null], [81, "handoff"], [85, null], [91, "stop"], [95, null], [3, "Fresh shared-usage"]]) {
    percent = next;
    const output = await handleUsageGuard(f.event, { ...options, now: at });
    if (expected) {
      assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
      assert.match(output.hookSpecificOutput.additionalContext, new RegExp(expected));
      assert.ok(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= USAGE_GUARD_MAX_CONTEXT_BYTES);
      assert.equal(output.continue, undefined);
      assert.equal(output.decision, undefined);
    } else assert.equal(output, null);
    at += 60_000;
  }
});

test("a concurrency change only emits when it changes the requested action", async (t) => {
  const f = await fixture(t);
  let working = 1;
  const options = { dataRoot: f.dataRoot, provider: "claude", query: async () => snapshot(66, { working }) };
  assert.equal(await handleUsageGuard(f.event, { ...options, now }), null);
  working = 2;
  const warning = await handleUsageGuard(f.event, { ...options, now: now + 60_000 });
  assert.match(warning.hookSpecificOutput.additionalContext, /2 observed working Claude sessions/);
  working = 3;
  assert.equal(await handleUsageGuard(f.event, { ...options, now: now + 120_000 }), null);
});

test("unavailable monitor warns once, remains bounded, and does not start provider work", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const options = { dataRoot: f.dataRoot, provider: "claude", query: async () => { calls++; throw new Error("SECRET private path token"); } };
  const output = await handleUsageGuard(f.event, { ...options, now });
  assert.match(output.hookSpecificOutput.additionalContext, /unknown, not zero usage/);
  assert.doesNotMatch(JSON.stringify(output), /SECRET|private path|token/);
  assert.equal(await handleUsageGuard(f.event, { ...options, now: now + 60_000 }), null);
  assert.equal(calls, 2);
});

test("parallel tool completions and a following batch are deduplicated without extra queries", async (t) => {
  const f = await fixture(t);
  let release;
  let calls = 0;
  const query = async () => { calls++; await new Promise((resolve) => { release = resolve; }); return snapshot(81); };
  const options = { dataRoot: f.dataRoot, provider: "claude", now, query };
  const pending = handleUsageGuard(f.event, options);
  assert.equal(await handleUsageGuard(f.event, options), null);
  release();
  assert.ok(await pending);
  assert.equal(await handleUsageGuard({ ...f.event, hook_event_name: "PostToolBatch" }, options), null);
  assert.equal(calls, 1);
});

test("resume rechecks and refreshes stale advice; independent delegated actors keep separate state", async (t) => {
  const f = await fixture(t);
  const options = { dataRoot: f.dataRoot, provider: "claude", now, query: async () => snapshot(81) };
  assert.ok(await handleUsageGuard(f.event, options));
  assert.equal(await handleUsageGuard({ ...f.event, hook_event_name: "SessionStart" }, options), null);
  assert.ok(await handleUsageGuard({ ...f.event, hook_event_name: "SessionStart" }, { ...options, now: now + 60_000 }));
  assert.ok(await handleUsageGuard({ ...f.event, agent_id: "child-1" }, options));
  assert.equal(await handleUsageGuard({ ...f.event, agent_id: "child-1" }, options), null);
});

test("persistent state contains only fixed bounded coordination fields, never payloads or observations", async (t) => {
  const f = await fixture(t);
  const event = { ...f.event, tool_input: { command: "PRIVATE_COMMAND", prompt: "PRIVATE_PROMPT" }, tool_response: "PRIVATE_RESPONSE", transcript_path: "PRIVATE_PATH" };
  await handleUsageGuard(event, { dataRoot: f.dataRoot, provider: "claude", now, query: async () => snapshot(91) });
  const files = await readdir(path.join(f.dataRoot, "usage-guards"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const text = await readFile(path.join(f.dataRoot, "usage-guards", files[0]), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["configHash", "lastCheckAt", "stage", "version"]);
  assert.doesNotMatch(text, /PRIVATE|test-session|resetsAt|usedPercent|token|command|prompt/i);
});

test("missing/off/invalid policy and unsupported events do no query work; policy edits take effect", async (t) => {
  const f = await fixture(t, { version: 1, mode: "off" });
  let calls = 0;
  const options = { dataRoot: f.dataRoot, provider: "codex", now, query: async () => { calls++; return snapshot(81, { provider: "codex" }); } };
  assert.equal(await handleUsageGuard(f.event, options), null);
  await writeFile(path.join(f.root, ".pomegr", "usage-guard.json"), JSON.stringify(config));
  assert.ok(await handleUsageGuard(f.event, options));
  assert.equal(await handleUsageGuard({ ...f.event, hook_event_name: "Stop" }, options), null);
  assert.equal(await handleUsageGuard({ ...f.event, session_id: "../escape" }, options), null);
  assert.equal(await handleUsageGuard(f.event, { ...options, provider: "unknown" }), null);
  assert.equal(calls, 1);
  await rm(path.join(f.root, ".pomegr", "usage-guard.json"));
  assert.equal(await handleUsageGuard(f.event, options), null);
});

test("configuration search stops at repository boundary and rejects oversized files", async (t) => {
  const f = await fixture(t);
  const child = path.join(f.root, "nested");
  await mkdir(child);
  assert.equal(readUsageGuardConfig(child).repositoryRoot, f.root);
  await mkdir(path.join(child, ".git"));
  assert.equal(readUsageGuardConfig(child), null);
  await writeFile(path.join(f.root, ".pomegr", "usage-guard.json"), " ".repeat(4097));
  assert.equal(readUsageGuardConfig(f.root), null);
});

test("a future private state clock cannot suppress checks indefinitely", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.dataRoot, "usage-guards"), { recursive: true });
  const filename = `${guardHash("claude:test-session:primary")}.json`;
  await writeFile(path.join(f.dataRoot, "usage-guards", filename), JSON.stringify({ version: 1, stage: "normal", lastCheckAt: now + 1, configHash: guardHash(JSON.stringify(config)) }));
  assert.ok(await handleUsageGuard(f.event, { dataRoot: f.dataRoot, provider: "claude", now, query: async () => snapshot(81) }));
});

test("notices remain bounded for maximum concurrency and malformed provider text cannot leak", () => {
  for (const percent of [71, 81, 100]) {
    const value = snapshot(percent, { working: 9999, live: 10000, unknown: 1 });
    value.providers[0].windows[0].window = "PRIVATE_PROVIDER_OUTPUT";
    const notice = usageGuardNotice(evaluateUsageGuard(value, "claude", config, now), "claude");
    assert.ok(Buffer.byteLength(notice) <= USAGE_GUARD_MAX_CONTEXT_BYTES, `notice was ${Buffer.byteLength(notice)} bytes`);
    assert.doesNotMatch(notice, /PRIVATE/);
    assert.match(notice, /repository's existing handoff workflow, location, format/);
    assert.match(notice, /If no workflow is defined, leave a concise handoff in the conversation/);
    assert.doesNotMatch(notice, /\.pomegr\/handoffs|\.gitignore/);
    assert.match(notice, percent === 71 ? /save the handoff now/ : /pause voluntarily/);
  }
});

test("abandoned lock/temp files are pruned without deleting unrelated files, including clock rollback", async (t) => {
  const f = await fixture(t);
  const actualNow = Date.now();
  const directory = path.join(f.dataRoot, "usage-guards");
  await mkdir(directory, { recursive: true });
  const ownLock = `${guardHash("claude:test-session:primary")}.json.lock`;
  const otherLock = `${guardHash("abandoned")}.json.lock`;
  const temporary = `${guardHash("abandoned")}.json.1234567890abcdef.tmp`;
  for (const [name, delta] of [[ownLock, 60_000], [otherLock, -60_000], [temporary, -60_000]]) {
    const file = path.join(directory, name);
    await writeFile(file, "");
    await utimes(file, new Date(actualNow + delta), new Date(actualNow + delta));
  }
  await writeFile(path.join(directory, "unrelated.lock"), "keep");
  const output = await handleUsageGuard(f.event, { dataRoot: f.dataRoot, provider: "claude", now: actualNow, query: async () => snapshot(81, { at: actualNow }) });
  assert.ok(output);
  assert.deepEqual((await readdir(directory)).sort(), [`${guardHash("claude:test-session:primary")}.json`, "unrelated.lock"].sort());
});

test("CLI ignores malformed and oversized hook input without printing private content", () => {
  for (const input of ["SECRET", " ".repeat(USAGE_GUARD_MAX_INPUT_BYTES + 1), JSON.stringify({ hook_event_name: "Stop", prompt: "SECRET" })]) {
    const result = spawnSync(process.execPath, ["scripts/usage-guard.mjs", "--provider", "claude"], { input, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("packaged hooks read the authenticated local cache without model calls and remain quiet across processes", async (t) => {
  const f = await fixture(t);
  const token = createAgentQueryCapability();
  let percent = 3;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, "GET");
    assert.equal(request.headers[AGENT_QUERY_AUTH_HEADER.toLowerCase()], token);
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(url.pathname, "/api/agent/v1/usage-limits");
    const provider = url.searchParams.get("provider");
    assert.ok(["claude", "codex"].includes(provider));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(snapshot(percent, { provider, at: Date.now() })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await publishAgentQueryDescriptor({ dataRoot: f.dataRoot, origin: `http://127.0.0.1:${server.address().port}`, token });
  const run = (file, provider, sessionId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(file), "--provider", provider], {
      cwd: f.root, windowsHide: true,
      env: { ...process.env, POMEGR_DATA_DIR: f.dataRoot }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Guard hook timed out")); }, 5000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify({ ...f.event, session_id: sessionId, tool_input: "PRIVATE_PROMPT", tool_response: "PRIVATE_RESPONSE" }));
  });
  for (const [provider, file] of [["claude", "plugins/claude-code/scripts/usage-guard.bundle.mjs"], ["codex", "plugins/pomegr/scripts/usage-guard.bundle.mjs"]]) {
    percent = 3;
    const before = requests;
    assert.deepEqual(await run(file, provider, "quiet"), { code: 0, stdout: "", stderr: "" });
    percent = 6;
    assert.deepEqual(await run(file, provider, "quiet"), { code: 0, stdout: "", stderr: "" });
    assert.equal(requests, before + 1);
    percent = 82;
    const warning = await run(file, provider, "handoff");
    assert.equal(warning.code, 0);
    assert.equal(warning.stderr, "");
    const output = JSON.parse(warning.stdout);
    assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
    assert.match(output.hookSpecificOutput.additionalContext, /save the handoff now/);
    assert.doesNotMatch(warning.stdout, /PRIVATE|agent-query-runtime/);
    assert.ok(!warning.stdout.includes(token));
    assert.equal(requests, before + 2);
  }
});
