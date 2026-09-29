import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  assertDevelopmentPortsAvailable,
  prewarmDevelopmentServices,
  replaceDevelopmentServices,
  startDev,
  terminateChildTree,
} from "../scripts/dev.mjs";

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killSignals.push(signal);
    child.signalCode = signal;
    child.emit("exit", null, signal);
    return true;
  };
  return child;
}

function supervisorOptions(children, overrides = {}) {
  const calls = { exits: [], logs: [], terminated: [], warnings: [] };
  let spawned = 0;
  return {
    calls,
    options: {
      replaceServicesFn: async () => {},
      assertPortsAvailableFn: async () => {},
      spawnFn: () => children[spawned++],
      terminateFn: async (child) => calls.terminated.push(child.pid),
      exitFn: (code) => calls.exits.push(code),
      signalTarget: new EventEmitter(),
      logger: {
        log: (message) => calls.logs.push(message),
        warn: (message) => calls.warnings.push(message),
      },
      ...overrides,
    },
  };
}

test("prewarms the web state route only after both local services are ready", async () => {
  const calls = [];
  const releases = new Map();
  const waitForPortFn = (port) => {
    calls.push(`wait:${port}`);
    return new Promise((resolve) => releases.set(port, resolve));
  };
  const fetchFn = async (url, options) => {
    calls.push(`fetch:${url}`);
    assert.equal(options.cache, "no-store");
    assert.equal(options.signal.aborted, false);
    return { ok: true, body: { cancel: async () => calls.push("cancel") } };
  };

  const prewarm = prewarmDevelopmentServices({ waitForPortFn, fetchFn });
  await Promise.resolve();
  assert.deepEqual(calls, ["wait:4317", "wait:3003"]);

  releases.get(4317)();
  await Promise.resolve();
  assert.equal(calls.some((call) => call.startsWith("fetch:")), false);

  releases.get(3003)();
  await prewarm;
  assert.deepEqual(calls, [
    "wait:4317",
    "wait:3003",
    "fetch:http://127.0.0.1:3003/api/state",
    "cancel",
  ]);
});

test("rejects an unsuccessful prewarm without reading or logging its response", async () => {
  let canceled = false;
  await assert.rejects(
    prewarmDevelopmentServices({
      waitForPortFn: async () => {},
      fetchFn: async () => ({ ok: false, body: { cancel: async () => { canceled = true; } } }),
    }),
    /Development API prewarm failed/,
  );
  assert.equal(canceled, true);
});

test("refuses startup when an unrelated listener already owns a local port", async () => {
  const checks = [];
  await assert.rejects(assertDevelopmentPortsAvailable({
    checkPortFn: async (port, host, timeoutMs) => {
      checks.push({ port, host, timeoutMs });
      return port === 3003;
    },
  }), /already in use/);
  assert.deepEqual(checks, [
    { port: 4317, host: "127.0.0.1", timeoutMs: 100 },
    { port: 3003, host: "127.0.0.1", timeoutMs: 100 },
  ]);

  let spawned = false;
  const exits = [];
  const started = await startDev({
    replaceServicesFn: async () => {},
    assertPortsAvailableFn: async () => { throw new Error("PRIVATE_ERROR_MUST_NOT_LEAK"); },
    spawnFn: () => { spawned = true; },
    exitFn: (code) => exits.push(code),
    signalTarget: new EventEmitter(),
    logger: { log() {}, warn() {} },
  });
  assert.equal(started, false);
  assert.equal(spawned, false);
  assert.deepEqual(exits, [1]);
});

test("Windows shutdown targets the exact wrapper process tree and waits for taskkill", async () => {
  const child = fakeChild(4242);
  const invocations = [];
  const spawnFn = (command, args, options) => {
    invocations.push({ command, args, options });
    const killer = new EventEmitter();
    killer.kill = () => {};
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      killer.emit("exit", 0, null);
    });
    return killer;
  };

  await terminateChildTree(child, { platform: "win32", spawnFn, timeoutMs: 50 });
  assert.deepEqual(invocations, [{
    command: "taskkill.exe",
    args: ["/pid", "4242", "/T", "/F"],
    options: { stdio: "ignore", windowsHide: true },
  }]);
  assert.deepEqual(child.killSignals, []);
});

for (const failure of ["exit", "error"]) {
  test(`stops both services when a child emits ${failure} before readiness`, async () => {
    const children = [fakeChild(101), fakeChild(202)];
    const { calls, options } = supervisorOptions(children, { prewarmFn: () => new Promise(() => {}) });
    const startup = startDev(options);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    if (failure === "exit") {
      children[0].exitCode = 0;
      children[0].emit("exit", 0, null);
    } else {
      children[0].emit("error", new Error("PRIVATE_ERROR_MUST_NOT_LEAK"));
    }

    assert.equal(await startup, false);
    assert.deepEqual(calls.terminated, [101, 202]);
    assert.deepEqual(calls.exits, [1]);
    assert.deepEqual(calls.logs, []);
  });
}

test("an unexpected child signal remains fatal after readiness", async () => {
  const children = [fakeChild(303), fakeChild(404)];
  const { calls, options } = supervisorOptions(children, { prewarmFn: async () => {} });
  assert.equal(await startDev(options), true);
  assert.equal(calls.logs.length, 1);

  children[1].signalCode = "SIGTERM";
  children[1].emit("exit", null, "SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.terminated, [303, 404]);
  assert.deepEqual(calls.exits, [1]);
});

test("replaces existing services before checking ports or spawning replacements", async () => {
  const order = [];
  const children = [fakeChild(501), fakeChild(502)];
  const { options } = supervisorOptions(children, {
    replaceServicesFn: async () => { order.push("replace"); },
    assertPortsAvailableFn: async () => { order.push("ports"); },
    spawnFn: () => { order.push("spawn"); return children.shift(); },
    prewarmFn: async () => { order.push("prewarm"); },
  });
  assert.equal(await startDev(options), true);
  assert.deepEqual(order, ["replace", "ports", "spawn", "spawn", "prewarm"]);
});

test("Windows replacement uses a hidden bounded helper and reports only a fixed result", async () => {
  const logs = [];
  await replaceDevelopmentServices({
    platform: "win32",
    execFileFn: async (command, args, options) => {
      assert.equal(command, "powershell.exe");
      assert.equal(args.at(-2), "-File");
      assert.match(args.at(-1), /stop-dev-services\.ps1$/);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.env.POMEGR_DEV_LAUNCHER_PID, String(process.pid));
      return { stdout: "3\r\n" };
    },
    logger: { log: (message) => logs.push(message) },
  });
  assert.deepEqual(logs, ["[pomegr] Stopped the previous Pomegr development services."]);
});

test("cleanup failures prevent spawning and expose only safe actionable diagnostics", async () => {
  for (const [code, expected] of [[10, /Port 3003/], [11, /Port 4317/], [12, /ownership changed/], [13, /Could not inspect/]]) {
    const { calls, options } = supervisorOptions([], {
      replaceServicesFn: () => replaceDevelopmentServices({
        platform: "win32",
        execFileFn: async () => { throw Object.assign(new Error("PRIVATE_ERROR_MUST_NOT_LEAK"), { code }); },
      }),
      spawnFn: () => assert.fail("must not spawn on cleanup failure"),
    });
    assert.equal(await startDev(options), false);
    assert.match(calls.warnings[0], expected);
    assert.doesNotMatch(calls.warnings[0], /PRIVATE_ERROR/);
    assert.deepEqual(calls.exits, [1]);
  }
});

test("non-Windows startup retains its port-check behavior", async () => {
  await replaceDevelopmentServices({ platform: "linux", execFileFn: () => assert.fail("Windows helper must not run") });
});
