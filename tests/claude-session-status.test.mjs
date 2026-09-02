import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, appendFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import {
  createClaudeSessionStatusReader, normalizeClaudeSessionRegistryEntry,
  registryStatus, sessionActivityStatus,
} from "../monitor/providers/claude-session-status.mjs";
import { assertNoPrivateFixtureSentinels, monitorStateFromProviderEvidence } from "./helpers/provider-fixtures.mjs";

const START = Date.parse("2026-08-31T16:00:00Z");
const REMOTE = "session_PRIVATEBRIDGE";
const TOKEN = "OAUTH_TOKEN_MUST_NOT_LEAK";
const PRIVATE = "REMOTE_PAYLOAD_MUST_NOT_LEAK";

async function fixture(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "pomegr-native-status-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const claudeRoot = path.join(homeDir, ".claude");
  await mkdir(claudeRoot);
  const credentials = path.join(claudeRoot, ".credentials.json");
  await writeFile(credentials, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
  let clock = START;
  return { homeDir, claudeRoot, credentials, now: () => clock, advance: (ms) => { clock += ms; } };
}

function registry(overrides = {}) {
  const entry = normalizeClaudeSessionRegistryEntry({
    sessionId: "local-session", entrypoint: "sdk-cli", bridgeSessionId: REMOTE,
    pid: 123, procStart: "owner-start", ...overrides,
  }, START - 1000);
  if (entry) entry.resourceOwner = { pid: entry.pid, processStartIdentity: entry.procStart };
  return new Map(entry ? [[entry.sessionId, entry]] : []);
}

function reply(status, fields = {}, envelope = "response_shape") {
  return Response.json({ [envelope]: {
    id: REMOTE, status: "active", worker_status: status,
    title: PRIVATE, config: { prompt: PRIVATE }, requires_action_details_list: [PRIVATE],
    ...fields,
  } });
}

function primary(evidence) { return evidence.agents.find((agent) => agent.id === "primary"); }
function assertPrivate(value) {
  const serialized = JSON.stringify(value);
  assertNoPrivateFixtureSentinels(serialized);
  for (const forbidden of [REMOTE, "cse_PRIVATEBRIDGE", PRIVATE, "api.anthropic.com", "remoteSessionId", "worker_status", "Bearer "]) {
    assert.equal(serialized.includes(forbidden), false, "private native field leaked: " + forbidden);
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "observer did not publish expected state");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

for (const [native, activity, agent, needsInput] of [
  ["running", "working", "active", false],
  ["requires_action", "needs_input", "waiting", true],
  ["idle", "open", "idle", false],
]) {
  test("maps explicit native " + native + " without transcript heuristics", async (t) => {
    const f = await fixture(t);
    let requests = 0;
    const reader = createClaudeSessionStatusReader({ ...f, fetch: async (url, options) => {
      requests += 1;
      assert.equal(url, "https://api.anthropic.com/v1/code/sessions/" + REMOTE);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer " + TOKEN);
      assert.ok(options.signal instanceof AbortSignal);
      return reply(native, { id: "cse_PRIVATEBRIDGE" });
    } });
    const rows = registry();
    await reader.refresh(rows, ["local-session"]);
    const entry = rows.get("local-session");
    assert.equal(sessionActivityStatus(true, entry), activity);
    assert.equal(registryStatus(entry, "warm"), agent);
    assert.equal(entry.needsInput, needsInput);
    assert.equal(entry.updatedAt, START);
    f.advance(20_000);
    const normalizedOnly = registry();
    reader.apply(normalizedOnly, ["local-session"]);
    assert.equal(requests, 1, "U2 application must not acquire native data even after TTL");
    assert.equal(normalizedOnly.get("local-session").status, agent);
  });
}

test("only a validated owner upgrades a live idle runtime to open", () => {
  assert.equal(sessionActivityStatus(true, registry({ status: "idle" }).get("local-session")), "open");
  const unowned = registry({ status: "idle" });
  delete unowned.get("local-session").resourceOwner;
  assert.equal(sessionActivityStatus(true, unowned.get("local-session")), "idle");
  assert.equal(sessionActivityStatus(false, registry({ status: "idle" }).get("local-session")), "idle");
});

test("accepts the older session envelope with the exact native identity", async (t) => {
  const f = await fixture(t);
  const reader = createClaudeSessionStatusReader({ ...f, fetch: async () => reply("running", {}, "session") });
  const rows = registry();
  await reader.refresh(rows, ["local-session"]);
  assert.equal(sessionActivityStatus(true, rows.get("local-session")), "working");
});

test("ignores invalid schemas, mismatched identities, archived records, oversized bodies and sanitized failures", async (t) => {
  const f = await fixture(t);
  const cases = [
    () => reply("working"),
    () => reply(undefined),
    () => reply("running", { id: "session_another" }),
    () => reply("running", { id: "../unsafe" }),
    () => reply("running", { status: "archived" }),
    () => Response.json({ arbitrary: PRIVATE }),
    () => new Response("not json " + PRIVATE),
    () => new Response(" ".repeat(256 * 1024 + 1)),
    () => new Response("{}", { headers: { "content-length": String(256 * 1024 + 1) } }),
    () => new Response(PRIVATE, { status: 401 }),
    () => new Response(PRIVATE, { status: 429 }),
    () => new Response(PRIVATE, { status: 302, headers: { location: "https://example.invalid/" } }),
    () => { throw new DOMException(PRIVATE, "TimeoutError"); },
    () => { throw new Error(TOKEN + PRIVATE); },
  ];
  for (const response of cases) {
    const reader = createClaudeSessionStatusReader({ ...f, fetch: async () => response() });
    const rows = registry();
    await reader.refresh(rows, ["local-session"]);
    assert.equal(sessionActivityStatus(true, rows.get("local-session")), "unknown");
    assert.equal(registryStatus(rows.get("local-session"), "active"), "unknown");
  }
});

test("requests only bounded SDK associations with confirmed process owners and credentials", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const reader = createClaudeSessionStatusReader({ ...f, fetch: async () => { requests += 1; return reply("running"); } });
  const unowned = registry();
  delete unowned.get("local-session").resourceOwner;
  const candidates = [unowned, registry({ entrypoint: "cli" }), registry({ bridgeSessionId: "../../unsafe" }), registry({ bridgeSessionId: "session_" + "x".repeat(121) })];
  for (const rows of candidates) await reader.refresh(rows, ["local-session"]);
  await reader.refresh(registry(), ["historical-session"]);
  await rm(f.credentials);
  await reader.refresh(registry(), ["local-session"]);
  assert.equal(requests, 0);
});

test("coalesces concurrent refreshes and caches unchanged success without advancing its timestamp", async (t) => {
  const f = await fixture(t);
  let release;
  let requests = 0;
  const ready = new Promise((resolve) => { release = resolve; });
  const reader = createClaudeSessionStatusReader({ ...f, fetch: async () => { requests += 1; await ready; return reply("running"); } });
  const one = registry(); const two = registry();
  const pending = Promise.all([reader.refresh(one, ["local-session"]), reader.refresh(two, ["local-session"])]);
  assert.equal(requests, 1);
  release(); await pending;
  f.advance(9999);
  await reader.refresh(registry(), ["local-session"]);
  assert.equal(requests, 1);
  f.advance(1);
  const later = registry();
  await reader.refresh(later, ["local-session"]);
  assert.equal(requests, 2);
  assert.equal(later.get("local-session").updatedAt, START);
});

test("retains last valid lifecycle through temporary failure with a sixty-second retry delay", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  let failing = false;
  const reader = createClaudeSessionStatusReader({ ...f, fetch: async () => { requests += 1; if (failing) throw Error(PRIVATE); return reply("running"); } });
  await reader.refresh(registry(), ["local-session"]);
  f.advance(10_000); failing = true;
  const failed = registry(); await reader.refresh(failed, ["local-session"]);
  assert.equal(sessionActivityStatus(true, failed.get("local-session")), "working");
  assert.equal(failed.get("local-session").updatedAt, START);
  f.advance(59_999); await reader.refresh(registry(), ["local-session"]);
  assert.equal(requests, 2);
  f.advance(1); await reader.refresh(registry(), ["local-session"]);
  assert.equal(requests, 3);
});

test("invalidates cached lifecycle on owner, bridge, credential replacement, and removal", async (t) => {
  const f = await fixture(t);
  for (const replacement of ["owner", "bridge", "token", "removed"]) {
    await writeFile(f.credentials, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
    let fail = false;
    const reader = createClaudeSessionStatusReader({ ...f, fetch: async () => { if (fail) throw Error(PRIVATE); return reply("running"); } });
    await reader.refresh(registry(), ["local-session"]); fail = true;
    const rows = registry(replacement === "owner" ? { procStart: "new-owner" } : replacement === "bridge" ? { bridgeSessionId: "session_newbridge" } : {});
    if (replacement === "token") await writeFile(f.credentials, JSON.stringify({ claudeAiOauth: { accessToken: "replacement-token" } }));
    if (replacement === "removed") { await reader.refresh(new Map(), []); }
    await reader.refresh(rows, ["local-session"]);
    assert.equal(sessionActivityStatus(true, rows.get("local-session")), "unknown", replacement);
  }
});

test("an old in-flight response cannot overwrite a replacement owner", async (t) => {
  const f = await fixture(t);
  let release;
  let requests = 0;
  const ready = new Promise((resolve) => { release = resolve; });
  const reader = createClaudeSessionStatusReader({ ...f, fetch: async () => {
    requests += 1;
    if (requests === 1) { await ready; return reply("running"); }
    return reply("idle");
  } });
  const old = registry();
  const pending = reader.refresh(old, ["local-session"]);
  const current = registry({ procStart: "new-owner" });
  await reader.refresh(current, ["local-session"]);
  release(); await pending;
  assert.equal(sessionActivityStatus(true, old.get("local-session")), "unknown");
  assert.equal(sessionActivityStatus(true, current.get("local-session")), "open");
});

test("bounds native concurrency and allows new visible sessions into a full cache", async (t) => {
  const f = await fixture(t);
  let active = 0; let maximum = 0; let calls = 0;
  const reader = createClaudeSessionStatusReader({ ...f, fetch: async (url) => {
    calls += 1; active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve)); active -= 1;
    return reply("running", { id: url.split("/").at(-1) });
  } });
  const rows = new Map();
  for (let i = 0; i < 51; i += 1) {
    const entry = registry({ sessionId: "local" + i, bridgeSessionId: "session_remote" + i }).values().next().value;
    rows.set(entry.sessionId, entry);
  }
  await reader.refresh(rows, [...rows.keys()].slice(0, 50));
  assert.equal(calls, 50); assert.ok(maximum <= 4);
  await reader.refresh(rows, ["local50"]);
  assert.equal(calls, 51);
  assert.equal(sessionActivityStatus(true, rows.get("local50")), "working");
});

async function providerFixture(t) {
  const f = await fixture(t);
  const project = path.join(f.claudeRoot, "projects", "fixture-project");
  const registryRoot = path.join(f.claudeRoot, "sessions");
  await mkdir(project, { recursive: true }); await mkdir(registryRoot);
  const file = path.join(project, "local-session.jsonl");
  const records = [
    { type: "custom-title", customTitle: "Native status fixture", timestamp: new Date(START).toISOString() },
    { type: "user", timestamp: new Date(START).toISOString(), message: { content: "PROMPT_MUST_NOT_LEAK" } },
    { type: "assistant", timestamp: new Date(START + 1000).toISOString(), message: {
      model: "fixture-model", content: [{ type: "tool_use", id: "question", name: "AskUserQuestion", input: { questions: ["PROMPT_MUST_NOT_LEAK"] } }],
    } },
  ];
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const ownerFile = path.join(registryRoot, "123.json");
  await writeFile(ownerFile, JSON.stringify({ sessionId: "local-session", entrypoint: "sdk-cli", bridgeSessionId: REMOTE, pid: 123, procStart: "owner-start" }));
  let native = "running"; let calls = 0;
  const provider = createClaudeProvider({
    homeDir: f.homeDir, env: {}, now: f.now,
    registryProcessIdentities: () => new Map([[123, "owner-start"]]),
    fetch: async () => { calls += 1; return reply(native); },
    observerIntervalMs: 60_000, observerWatchSource: () => ({ close() {} }),
  });
  return { ...f, file, ownerFile, provider, calls: () => calls, status: (value) => { native = value; } };
}

test("provider catalog and primary agent share native lifecycle; U2 and historical reads never fetch", async (t) => {
  const f = await providerFixture(t);
  for (const [native, activity, agent] of [["running", "working", "active"], ["requires_action", "needs_input", "needs_input"], ["idle", "open", "idle"]]) {
    f.status(native); f.advance(10_000);
    const catalog = await f.provider.listSessions();
    const acquired = f.calls();
    const evidence = await f.provider.readSession("local-session");
    assert.equal(f.calls(), acquired, "U2 cannot perform native acquisition");
    assert.equal(catalog[0].activityStatus, activity);
    assert.equal(primary(evidence).status, agent, "native idle clears the old transcript question");
    assertPrivate(catalog); assertPrivate(evidence);
    assertPrivate(monitorStateFromProviderEvidence("claude", evidence));
  }
  await rm(f.ownerFile);
  const before = f.calls();
  const evidence = await f.provider.readSession("local-session");
  assert.equal(f.calls(), before);
  // Whether the startup/exit grace still considers the file live cannot trigger a remote read.
  assertPrivate(evidence);
});

test("retains an old idle registered session as open until its owner terminates", async (t) => {
  const f = await providerFixture(t);
  // Make transcript activity older than both the normal five-minute window and
  // the registry grace period. Registration plus validated ownership is the
  // only reason this session remains in the live catalog.
  const old = new Date(START - 10 * 60_000);
  await utimes(f.file, old, old);
  await writeFile(f.ownerFile, JSON.stringify({
    sessionId: "local-session", entrypoint: "cli", status: "idle",
    pid: 123, procStart: "owner-start",
  }));
  const registered = (await f.provider.listSessions())[0];
  assert.equal(registered.isLive, true);
  assert.equal(registered.activityStatus, "open");

  await rm(f.ownerFile);
  const historical = (await f.provider.listSessions())[0];
  assert.equal(historical.isLive, false);
  assert.equal(historical.activityStatus, "idle");
});

test("observer commits native transitions without transcript growth and retains incomplete replacements", async (t) => {
  const f = await providerFixture(t);
  const observer = f.provider.createObserver();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const published = [];
  await observer.start({ publishCatalog() {}, publishSession(_id, evidence) { published.push(evidence); }, invalidateSession() {} }, controller.signal);
  await waitFor(() => published.length > 0);
  assert.equal(primary(published.at(-1)).status, "active");
  f.advance(10_000); f.status("requires_action");
  await observer.hydrate("local-session");
  assert.equal(primary(published.at(-1)).status, "needs_input");
  const unchanged = published.length;
  await observer.hydrate("local-session");
  assert.equal(published.length, unchanged);
  await appendFile(f.file, '{"type":"system"');
  f.advance(10_000); f.status("idle");
  await observer.hydrate("local-session");
  assert.equal(published.length, unchanged, "partial source replacement must retain last complete revision");
  await appendFile(f.file, '}\n');
  await observer.hydrate("local-session");
  assert.equal(primary(published.at(-1)).status, "idle");
  for (const evidence of published) {
    assertPrivate(evidence);
    assert.match(evidence.observationSource.fingerprint, /^[a-f0-9]{64}$/);
  }
  controller.abort();
});
