import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRepositoryPluginRuntime } from "../monitor/repository-plugin-runtime.mjs";
import { createRepositoryPluginReleaseReader } from "../monitor/repository-plugin-releases.mjs";
import { comparePluginVersions, repositoryPluginSetupSchema } from "../shared/repository-plugin-state.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";
import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";

const id = "repo-0123456789abcdef01234567";
const root = process.platform === "win32" ? "C:\\private\\project" : "/private/project";
const stamp = "2026-09-06T10:00:00.000Z";
const installed = () => ({ installation: "installed", version: "0.5.0", enabled: true, scope: "user",
  privateAction: { marketplaceRegistered: true, ref: "main", sourceTrusted: true } });

function fixture(options = {}) {
  const runtime = createRepositoryPluginRuntime({
    registry: { providers: ["claude", "codex"].map((id) => ({ id, readRepositoryPluginSetup: options.inspect || (async () => installed()) })) },
    readRelease: async () => ({ status: "ready", version: "0.6.0", checkedAt: stamp }),
    readReporting: async () => ({ status: "configured", version: 7, checkedAt: stamp }),
    now: () => Date.parse(stamp), ...options,
  });
  runtime.syncTargets([{ id, root, name: "Project", providers: ["claude", "codex"] }]);
  return runtime;
}

test("plugin snapshots are explicitly projected; private provenance and paths never reach public state", async () => {
  const runtime = fixture({ inspect: async () => ({ ...installed(), command: "secret", prompt: "secret", token: "secret", privateAction: { ...installed().privateAction, credentials: "secret" } }) });
  await runtime.refresh(id, "claude");
  const value = runtime.read(id, "claude");
  assert.equal(value.version, "0.5.0"); assert.equal(value.update.version, "0.6.0"); assert.equal(value.canUpdate, true);
  assert.equal(repositoryPluginSetupSchema.safeParse(value).success, true);
  assert.doesNotMatch(JSON.stringify(value), /secret|private|root|command|prompt|token|marketplaceRegistered/u);
  const plan = await runtime.prepare(id, "claude", "update");
  assert.equal(plan.root, root); assert.equal(plan.scope, "user"); assert.equal(plan.targetVersion, "0.6.0");
  assert.equal(await runtime.prepare("repo-ffffffffffffffffffffffff", "claude", "update"), null);
});

test("failed or incomplete replacement retains the last known version and observation time but disables actions", async () => {
  let fail = false; let tick = Date.parse(stamp);
  const runtime = fixture({ now: () => tick, inspect: async () => { if (fail) throw new Error("private path and provider payload"); return installed(); } });
  await runtime.refresh(id, "claude"); fail = true; tick += 60_000;
  assert.equal(await runtime.refresh(id, "claude"), "unavailable");
  const retained = runtime.read(id, "claude");
  assert.equal(retained.readiness, "unavailable"); assert.equal(retained.version, "0.5.0"); assert.equal(retained.checkedAt, stamp);
  assert.equal(retained.canUpdate, false); assert.equal(await runtime.prepare(id, "claude", "update"), null);
});

test("pins use their own source; disabled Codex and unavailable update sources never enable automatic update", async () => {
  const refs = [];
  const runtime = fixture({ inspect: async () => ({ ...installed(), privateAction: { ...installed().privateAction, ref: "v0.5.0" } }),
    readRelease: async (_provider, ref) => { refs.push(ref); return { status: "ready", version: "0.5.0", checkedAt: stamp }; } });
  await runtime.refresh(id, "claude"); assert.deepEqual(refs, ["v0.5.0"]);
  assert.equal(runtime.read(id, "claude").update.status, "pinned"); assert.equal(runtime.read(id, "claude").canUpdate, false);
  const disabled = fixture({ inspect: async () => ({ ...installed(), enabled: false }) });
  await disabled.refresh(id, "codex"); assert.equal(disabled.read(id, "codex").canUpdate, false);
  const offline = fixture({ readRelease: async () => ({ status: "unavailable", version: "0.6.0", checkedAt: stamp }) });
  await offline.refresh(id, "claude"); assert.equal(offline.read(id, "claude").version, "0.5.0");
  assert.equal(offline.read(id, "claude").update.status, "unavailable"); assert.equal(offline.read(id, "claude").canUpdate, false);
});

test("read-only snapshot access cannot acquire files or request releases, and rechecks coalesce", async () => {
  let reads = 0; let unblock;
  const runtime = fixture({ inspect: async () => { reads++; await new Promise((resolve) => { unblock = resolve; }); return installed(); } });
  for (let i = 0; i < 20; i++) { runtime.read(id, "claude"); runtime.reporting(id); }
  assert.equal(reads, 0);
  const first = runtime.refresh(id, "claude"); const second = runtime.refresh(id, "claude");
  assert.equal(reads, 1); unblock(); await Promise.all([first, second]); assert.equal(reads, 1);
  runtime.syncTargets([]); assert.equal(runtime.read(id, "claude").version, null);
});

test("official marketplace checks are bounded, cached, credential-free and fail closed", async () => {
  let calls = 0; let fail = false; let tick = Date.parse(stamp);
  const reader = createRepositoryPluginReleaseReader({ now: () => tick, fetch: async (url, options) => {
    calls++; assert.equal(url, "https://raw.githubusercontent.com/Lecarvalho/pomegr/main/plugins/pomegr/.codex-plugin/plugin.json");
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit"); assert.deepEqual(options.headers, { Accept: "application/json" });
    return fail ? new Response("x".repeat(32769)) : new Response(JSON.stringify({ name: "pomegr", version: "0.6.0", secret: "private" }));
  } });
  const result = await reader("codex", "main"); assert.equal(result.version, "0.6.0");
  await reader("codex", "main"); assert.equal(calls, 1);
  fail = true; tick += 3_600_001; const failed = await reader("codex", "main");
  assert.equal(failed.status, "unavailable"); assert.equal(failed.checkedAt, stamp); assert.equal(failed.version, "0.6.0");
  await reader("codex", "../../secret"); assert.equal(calls, 2);
});

test("shutdown cancels pending update requests and prevents late local reads from starting one", async () => {
  let requested;
  const started = new Promise((resolve) => { requested = resolve; });
  const release = createRepositoryPluginReleaseReader({ fetch: async (_url, { signal }) => {
    requested();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const runtime = fixture({ readRelease: release });
  const refresh = runtime.refresh(id, "claude");
  await started;
  await runtime.stop();
  await refresh;
  assert.equal(runtime.read(id, "claude").canUpdate, false);

  let unblock; let calls = 0;
  const late = fixture({ inspect: async () => { await new Promise((resolve) => { unblock = resolve; }); return installed(); },
    readRelease: async () => { calls++; return { status: "ready", version: "0.6.0", checkedAt: stamp }; } });
  const reading = late.refresh(id, "claude");
  const stopped = late.stop();
  unblock();
  await Promise.all([reading, stopped]);
  assert.equal(calls, 0);
});

test("version ordering compares semantic components and never offers a downgrade", () => {
  assert.equal(comparePluginVersions("0.10.0", "0.9.0"), 1);
  assert.equal(comparePluginVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(comparePluginVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(comparePluginVersions("private", "0.6.0"), null);
});

test("private plugin endpoints require desktop token, exact method, host, origin absence and bounded target", async (context) => {
  const token = "0123456789abcdef0123456789abcdef"; let reads = 0;
  const server = http.createServer(createRequestHandler({ authorizationToken: token, runtime: {
    prepareRepositoryPluginAction: async () => { reads++; return { root }; },
    refreshRepositoryPluginSetup: async () => "completed", readRepositoryPluginSetup: () => null,
  } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`; const headers = { [DESKTOP_AUTH_HEADER]: token };
  const url = `${origin}/internal/repository-plugin/prepare?repositoryId=${id}&provider=claude&action=update`;
  for (const options of [{}, { method: "POST" }, { method: "POST", headers: { ...headers, Origin: origin } }, { headers }]) {
    assert.equal((await fetch(url, options)).status, 401);
  }
  assert.equal((await fetch(url + "&ref=hostile", { method: "POST", headers })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers, body: "x" })).status, 400); assert.equal(reads, 0);
  assert.deepEqual(await (await fetch(url, { method: "POST", headers })).json(), { plan: { root } }); assert.equal(reads, 1);
});
