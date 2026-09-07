import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
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

const stopHelper = fileURLToPath(new URL("../scripts/stop-dev-services.ps1", import.meta.url));
const fixtureRoot = "C:\\Pomegr checkout";
function processFixture(pid, parent, script, suffix = "", overrides = {}) {
  return {
    ProcessId: pid, ParentProcessId: parent, Name: "node.exe", ExecutablePath: "C:\\node\\node.exe",
    CommandLine: `"C:\\node\\node.exe" "${script}"${suffix}`,
    CreationDate: `2026-09-06T12:00:${String(pid).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}
function runStopHelperTest(command, fixture = {}) {
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    ". $env:POMEGR_TEST_HELPER; $fixture = $env:POMEGR_TEST_FIXTURE | ConvertFrom-Json; " + command,
  ], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
    env: { ...process.env, POMEGR_TEST_HELPER: stopHelper, POMEGR_TEST_FIXTURE: JSON.stringify(fixture) },
  }).trim();
}
function stopPlan(processes, listeners = []) {
  return JSON.parse(runStopHelperTest(
    "try { $plan = @(Get-DevStopPlan @($fixture.processes) @($fixture.listeners) $fixture.root 99); " +
    "ConvertTo-Json -Compress -InputObject @($plan | ForEach-Object { $_.Process.ProcessId }) } " +
    "catch { ConvertTo-Json -Compress -InputObject $_.Exception.Message }",
    { processes, listeners, root: fixtureRoot },
  ));
}

test("Windows cleanup plans exact checkout trees child-first, including orphans", { skip: process.platform !== "win32" }, () => {
  const processes = [
    processFixture(1, 0, "scripts/dev.mjs"),
    processFixture(2, 1, fixtureRoot + "\\monitor\\cli.mjs"),
    processFixture(3, 1, fixtureRoot + "\\scripts\\run-vinext.mjs", " dev --port 3003"),
    processFixture(4, 3, fixtureRoot + "\\node_modules\\vinext\\dist\\cli.js", " dev --port 3003"),
    processFixture(5, 0, "C:\\other\\monitor\\cli.mjs"),
    processFixture(6, 0, fixtureRoot + "\\monitor\\cli.mjs"),
  ];
  const plan = stopPlan(processes, [{ LocalPort: 3003, OwningProcess: 4 }, { LocalPort: 4317, OwningProcess: 2 }]);
  assert.deepEqual([...plan].sort((a, b) => a - b), [1, 2, 3, 4, 6]);
  assert.ok(plan.indexOf(4) < plan.indexOf(3));
  assert.ok(plan.indexOf(3) < plan.indexOf(1));
  assert.ok(plan.indexOf(2) < plan.indexOf(1));
});

test("Windows cleanup rejects unrelated listeners and ignores lookalikes and build processes", { skip: process.platform !== "win32" }, () => {
  const processes = [
    processFixture(1, 0, "unrelated.mjs", ` "${fixtureRoot}\\monitor\\cli.mjs"`),
    processFixture(2, 0, fixtureRoot + "\\scripts\\run-vinext.mjs", " build"),
    processFixture(3, 0, fixtureRoot + "\\monitor\\cli.mjs.extra"),
    processFixture(4, 0, fixtureRoot + "\\monitor\\cli.mjs", "", { Name: "Pomegr.exe" }),
    processFixture(5, 0, fixtureRoot + "\\monitor\\cli.mjs", "", { ExecutablePath: null }),
    processFixture(6, 0, fixtureRoot + "\\monitor\\cli.mjs", "", { CommandLine: '"C:\\wrong\\node.exe" "' + fixtureRoot + '\\monitor\\cli.mjs"' }),
  ];
  assert.deepEqual(stopPlan(processes), []);
  assert.equal(stopPlan(processes, [{ LocalPort: 3003, OwningProcess: 1 }]), "POMEGR_DEV_PORT_3003");
  assert.equal(stopPlan(processes, [{ LocalPort: 4317, OwningProcess: 888 }]), "POMEGR_DEV_PORT_4317");
});

test("Windows cleanup protects the launcher and rejects recycled ancestry", { skip: process.platform !== "win32" }, () => {
  const processes = [
    processFixture(1, 0, "scripts/dev.mjs", "", { CreationDate: "2026-09-06T13:00:00.000Z" }),
    processFixture(2, 1, fixtureRoot + "\\monitor\\cli.mjs"),
    processFixture(3, 0, "scripts/dev.mjs"),
    processFixture(4, 3, fixtureRoot + "\\monitor\\cli.mjs"),
    processFixture(99, 3, "scripts/dev.mjs"),
  ];
  assert.deepEqual(stopPlan(processes).sort((a, b) => a - b), [2, 4]);
});

test("Windows cleanup revalidates identity before stopping a process", { skip: process.platform !== "win32" }, () => {
  const output = runStopHelperTest(
    "$original = $fixture.process; function Get-CimInstance { $copy = $original.PSObject.Copy(); $copy.CreationDate = 'changed'; return $copy }; " +
    "function Get-Process { throw 'MUST_NOT_OPEN_PROCESS' }; " +
    "try { Stop-DevPlan @([pscustomobject]@{ Process = $original }) } catch { Write-Output $_.Exception.Message }",
    { process: processFixture(1, 0, fixtureRoot + "\\monitor\\cli.mjs") },
  );
  assert.equal(output, "POMEGR_DEV_OWNERSHIP");
});

test("Windows cleanup can stop an owned native process with CIM identity checks", { skip: process.platform !== "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const exited = once(child, "exit");
  try {
    runStopHelperTest(
      "$entry = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $fixture.pid); " +
      "if (-not $entry) { throw 'Missing fixture' }; Stop-DevPlan @([pscustomobject]@{ Process = $entry }); Write-Output 'stopped'",
      { pid: child.pid },
    );
    await exited;
  } finally { child.kill(); }
});

test("a second Windows dev launch replaces the first and reaches readiness", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-dev-replacement-"));
  const children = [];
  const reservations = [createServer(), createServer()];
  try {
    const ports = await Promise.all(reservations.map(async (server) => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server.address().port;
    }));
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "monitor"));
    const devSource = await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
    const helperSource = await readFile(stopHelper, "utf8");
    const isolatedPorts = (source) => source.replace(/\b4317\b/g, String(ports[0])).replace(/\b3003\b/g, String(ports[1]));
    await writeFile(path.join(root, "scripts", "dev.mjs"), isolatedPorts(devSource));
    await writeFile(path.join(root, "scripts", "stop-dev-services.ps1"), isolatedPorts(helperSource));
    for (const [entry, port] of [["monitor/cli.mjs", ports[0]], ["scripts/run-vinext.mjs", ports[1]]]) {
      await writeFile(path.join(root, entry), `import { createServer } from 'node:http'; createServer((req, res) => res.end('ready')).listen(${port}, '127.0.0.1');`);
    }
    await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))));
    async function launch() {
      const child = spawn(process.execPath, ["scripts/dev.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      children.push(child);
      await new Promise((resolve, reject) => {
        let output = "";
        let errorOutput = "";
        const timer = setTimeout(() => reject(new Error("Isolated launcher did not become ready")), 15_000);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`Isolated launcher exited before readiness (code ${code}, signal ${signal}, stderr ${JSON.stringify(errorOutput)})`));
        });
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("Development services ready; API prewarmed.")) { clearTimeout(timer); resolve(); }
        });
        child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-4096); });
      });
      return child;
    }
    const first = await launch();
    const firstExited = once(first, "exit");
    const second = await launch();
    await firstExited;
    assert.equal(second.exitCode, null);
    for (const port of ports) {
      const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(await response.text(), "ready");
    }
  } finally {
    for (const server of reservations) { server.close(); }
    for (const child of children) { await terminateChildTree(child); }
    await rm(root, { recursive: true, force: true });
  }
});
