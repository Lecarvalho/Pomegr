import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPackageWithOptions, getRawHeader } from "@electron/asar";
import {
  DESKTOP_UNPACKED_FILES,
  DESKTOP_UNPACK_DIRECTORIES,
  SHARP_UNPACKED_FILES,
  WORKER_BUNDLE_FILES,
  unpackedFilesFromHeader,
} from "../desktop/asar-policy.mjs";
import { buildDesktopServiceBundles } from "../desktop/service-bundles.mjs";
import {
  assertNoSystemNodeInPath,
  executableOnPath,
  keepOnlyRuntimeEnvironment,
  minimalRuntimeEnvironment,
  monitorPrivateEnvironment,
} from "../desktop/environment-policy.mjs";
import { stopChild } from "../desktop/utility-lifecycle.mjs";

test("desktop smoke builds an ASAR fixture with GPU and profile safeguards", async () => {
  const [packageJson, main, runner] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/smoke-runner.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson.scripts["desktop:smoke"], /ELECTRON_RUN_AS_NODE=1/);
  assert.match(packageJson.scripts["desktop:smoke"], /electron[\\/]dist[\\/]electron\.exe desktop[\\/]smoke-runner\.mjs/);
  assert.doesNotMatch(packageJson.scripts["desktop:smoke"], /(^|\s)node(?:\.exe)?(?:\s|$)/i);
  assert.ok(main.indexOf("app.disableHardwareAcceleration()") < main.indexOf("app.whenReady()"));
  assert.match(main, /disable-gpu/);
  assert.match(main, /noerrdialogs/);
  assert.match(main, /THREADLIGHT_SMOKE_PROFILE_ROOT/);
  assert.doesNotMatch(main, /recordStage\(["']FINISHED_FAIL["']\)/);
  assert.match(main, /recordStage\(["']CLEANUP_FAILED["']\)/);
  assert.match(main, /recordStage\(["']WATCHDOG_TIMEOUT["']\)/);
  assert.match(main, /recordStage\(["']UNEXPECTED_QUIT["']\)/);
  assert.match(main, /new Worker\(/);
  assert.match(main, /execArgv:\s*\[\]/);
  assert.match(main, /env:\s*\{\s*\.\.\.environment/);
  assert.match(main, /worker\.terminate\(\)/);
  assert.match(main, /execFile\("git", \["--version"\]/);
  assert.doesNotMatch(main, /(?:spawn|execFile|fork)\([^\n]*["']node(?:\.exe)?["']/i);
  assert.doesNotMatch(main, /utilityProcess\.fork/);
  assert.match(runner, /createPackageWithOptions/);
  assert.match(runner, /app\.asar/);
  assert.match(runner, /unpackDir:\s*DESKTOP_UNPACK_DIRECTORIES/);
  assert.match(runner, /user-data-dir=/);
  assert.match(runner, /original-fs/);
  assert.match(runner, /THREADLIGHT_SMOKE_MAIN_STAGE_PATH/);
  assert.match(runner, /ELECTRON_EXIT_MISSING_DLL/);
  assert.match(runner, /ELECTRON_EXIT_BREAKPOINT/);
  assert.match(runner, /ELECTRON_EXIT_STACK_BUFFER/);
  assert.match(runner, /minimalRuntimeEnvironment\(process\.env/);
  assert.doesNotMatch(runner, /env:\s*\{\s*\.\.\.process\.env/s);
  assert.match(runner, /executableOnPath\(environment, ["']git\.exe["']\)/);
});

test("ASAR policy unpacks the monitor bundle, complete production build, and Sharp native files", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "threadlight-asar-policy-"));
  const stagingRoot = path.join(fixtureRoot, "staging");
  const archivePath = path.join(fixtureRoot, "app.asar");
  try {
    for (const relativePath of SHARP_UNPACKED_FILES) {
      const target = path.join(stagingRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, relativePath, "utf8");
    }
    for (const relativePath of WORKER_BUNDLE_FILES) {
      const target = path.join(stagingRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "export default true;\n", "utf8");
    }
    for (const relativePath of [
      "dist/server/index.js",
      "dist/server/ssr/index.js",
      "dist/server/ssr/assets/chunk.js",
    ]) {
      const target = path.join(stagingRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "export default true;\n", "utf8");
    }
    await writeFile(path.join(stagingRoot, "dist", "server", "ssr", "assets", "style.css"), "body {}\n", "utf8");
    await writeFile(path.join(stagingRoot, "packed.mjs"), "export default true;\n", "utf8");
    await createPackageWithOptions(stagingRoot, archivePath, { unpackDir: DESKTOP_UNPACK_DIRECTORIES });

    const distFiles = [
      "dist/server/index.js",
      "dist/server/ssr/index.js",
      "dist/server/ssr/assets/chunk.js",
      "dist/server/ssr/assets/style.css",
    ];
    const expected = [...DESKTOP_UNPACKED_FILES, ...distFiles].sort();
    assert.deepEqual(unpackedFilesFromHeader(getRawHeader(archivePath).header), expected);
    for (const relativePath of expected) {
      await access(path.join(`${archivePath}.unpacked`, ...relativePath.split("/")));
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("monitor is isolated and the in-main web host receives no provider paths or credentials", async () => {
  const [main, monitorHost] = await Promise.all([
    readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/monitor-host.mjs", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(main, /\.\.\/monitor\/|providers/);
  assert.match(monitorHost, /\.\.\/monitor\/server\.mjs/);
  assert.doesNotMatch(monitorHost, /node:child_process|execFile/);
  assert.doesNotMatch(main, /env:\s*\{\s*\.\.\.process\.env/s);
  assert.match(main, /minimalRuntimeEnvironment\(process\.env/);
  assert.ok(main.indexOf("keepOnlyRuntimeEnvironment(process.env") < main.indexOf('import("../web/server.mjs")'));
  assert.ok(main.indexOf("assertNoSystemNodeInPath(process.env)") < main.indexOf('import("../web/server.mjs")'));
  assert.match(main, /THREADLIGHT_MONITOR_ORIGIN:\s*monitor\.ready\.origin/);
  assert.match(monitorHost, /MONITOR_ENV_LOADING/);
  assert.match(monitorHost, /MONITOR_ENV_LOADED/);

  const nodeDirectory = path.join("C:\\", "runtime-with-node");
  const gitDirectory = path.join("C:\\", "git-only");
  const fakeFiles = new Set([
    path.normalize(path.join(nodeDirectory, "node.exe")),
    path.normalize(path.join(gitDirectory, "git.exe")),
  ]);
  const fileExists = (filename) => fakeFiles.has(path.normalize(filename));
  const source = {
    APPDATA: "private-app-data",
    AUTH_HEADER: "private-auth",
    CLAUDE_PROJECTS_DIR: "private-transcripts",
    CODEX_HOME: "private-codex",
    GH_TOKEN: "private-token",
    HOME: "private-home",
    OPENAI_API_KEY: "private-key",
    SERVICE_PAT: "private-pat",
    SSH_AUTH_SOCK: "private-socket",
    PATH: [nodeDirectory, gitDirectory].join(path.delimiter),
    SystemRoot: "safe-system-root",
    TEMP: "safe-temp",
  };
  const runtime = minimalRuntimeEnvironment(source, {}, fileExists);
  assert.equal(runtime.PATH, gitDirectory);
  assert.equal(executableOnPath(runtime, "git.exe", fileExists), true);
  assert.doesNotThrow(() => assertNoSystemNodeInPath(runtime, fileExists));
  assert.throws(() => assertNoSystemNodeInPath(source, fileExists), /DESKTOP_SYSTEM_NODE_VISIBLE/);
  for (const forbidden of ["APPDATA", "AUTH_HEADER", "CLAUDE_PROJECTS_DIR", "CODEX_HOME", "GH_TOKEN", "HOME", "OPENAI_API_KEY", "SERVICE_PAT", "SSH_AUTH_SOCK"]) {
    assert.equal(runtime[forbidden], undefined);
  }
  const webEnvironment = { ...source };
  keepOnlyRuntimeEnvironment(webEnvironment, { THREADLIGHT_MONITOR_ORIGIN: "http://127.0.0.1:4317" }, fileExists);
  assert.equal(webEnvironment.PATH, gitDirectory);
  assert.equal(webEnvironment.THREADLIGHT_MONITOR_ORIGIN, "http://127.0.0.1:4317");
  assert.equal(webEnvironment.SSH_AUTH_SOCK, undefined);

  const monitorEnvironment = monitorPrivateEnvironment(source);
  assert.deepEqual(monitorEnvironment, {
    APPDATA: "private-app-data",
    CLAUDE_PROJECTS_DIR: "private-transcripts",
    CODEX_HOME: "private-codex",
    HOME: "private-home",
  });
});

test("forced utility cleanup waits for the child exit and leaves no pid", async () => {
  class HangingUtility extends EventEmitter {
    pid = 7411;
    killCalls = 0;

    postMessage() {}

    kill() {
      this.killCalls += 1;
      setImmediate(() => {
        this.emit("exit", 1);
        setImmediate(() => {
          this.pid = undefined;
        });
      });
      return true;
    }
  }

  const child = new HangingUtility();
  const result = await stopChild(child, { gracefulTimeoutMs: 5, killTimeoutMs: 100 });
  assert.deepEqual(result, { forced: true });
  assert.equal(child.killCalls, 1);
  assert.equal(child.pid, undefined);
  assert.equal(child.listenerCount("exit"), 0);
});

test("monitor worker uses one physical bundle with fixed lifecycle stages", async () => {
  const [main, monitorHost, bundler, runtimeProof] = await Promise.all([
    readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/monitor-host.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/service-bundles.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/runtime-proof.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(main, /app\.getAppPath\(\).*\.unpacked/s);
  assert.match(main, /desktop[\s\S]*workers/);
  assert.match(bundler, /noExternal:\s*true/);
  assert.match(bundler, /codeSplitting:\s*false/);
  assert.doesNotMatch(main, /hang-probe/);
  assert.match(monitorHost, /MONITOR_RUNTIME_ASSERTING/);
  assert.match(main, /MAIN_GIT_EXECUTING/);
  assert.match(main, /MAIN_GIT_VERIFIED/);
  assert.match(main, /WEB_IMPORTING/);
  assert.match(main, /WEB_IMPORTED/);
  assert.match(main, /WEB_SERVER_STARTING/);
  assert.match(main, /WEB_SERVER_READY/);
  assert.match(main, /WEB_HEALTH_CHECKING/);
  assert.match(main, /WEB_HEALTH_VERIFIED/);
  assert.match(main, /app\.getAppPath\(\).*\.unpacked[\s\S]*dist/);
  assert.match(monitorHost, /MONITOR_STARTING/);
  assert.match(monitorHost, /MONITOR_READY/);
  assert.match(runtimeProof, /\^\(\?:MONITOR\|WEB\)_\[A-Z_\]/);
  assert.match(runtimeProof, /node\.exe/);
  assert.doesNotMatch(runtimeProof, /spawnSync\(\s*["']node/);
  assert.match(main, /THREADLIGHT_SMOKE_MAIN_STAGE_PATH/);
  assert.match(main, /TARGET_PRESENT/);
  assert.match(main, /EXIT_MISSING_DLL/);
  assert.match(main, /EXIT_NONZERO/);
});

test("desktop service bundling emits only the self-contained monitor worker", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "threadlight-worker-bundle-"));
  try {
    await buildDesktopServiceBundles(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), fixtureRoot);
    const outputRoot = path.join(fixtureRoot, "desktop", "workers");
    assert.deepEqual(await readdir(outputRoot), ["monitor-host.cjs"]);
    const bundle = await readFile(path.join(outputRoot, "monitor-host.cjs"), "utf8");
    assert.match(bundle, /DESKTOP_MONITOR_START_FAILED/);
    assert.doesNotMatch(bundle, /from\s+["'](?:\.\/|\.\.\/)/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
