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
import { startMonitorAfterEnvironment } from "../desktop/monitor-startup-policy.mjs";
import {
  assertNoSystemNodeInPath,
  executableOnPath,
  keepOnlyRuntimeEnvironment,
  minimalRuntimeEnvironment,
  monitorPrivateEnvironment,
} from "../desktop/environment-policy.mjs";
import { stopChild } from "../desktop/utility-lifecycle.mjs";
import { containsShellStageTrace } from "../desktop/runtime-proof.mjs";

test("production monitor readiness does not require Git while smoke readiness proves Git execution", async () => {
  const productionStages = [];
  let productionGitCalls = 0;
  const productionHandle = await startMonitorAfterEnvironment({
    smoke: false,
    recordStage: (stage) => productionStages.push(stage),
    verifyGitExecution: async () => {
      productionGitCalls += 1;
      throw new Error("GIT_MUST_NOT_GATE_PRODUCTION");
    },
    startMonitor: async () => ({ origin: "http://127.0.0.1:4317" }),
  });
  assert.deepEqual(productionHandle, { origin: "http://127.0.0.1:4317" });
  assert.equal(productionGitCalls, 0);
  assert.deepEqual(productionStages, ["MONITOR_STARTING"]);

  const smokeStages = [];
  let smokeStarted = false;
  await assert.rejects(startMonitorAfterEnvironment({
    smoke: true,
    recordStage: (stage) => smokeStages.push(stage),
    verifyGitExecution: async () => { throw new Error("DESKTOP_MONITOR_GIT_FAILED"); },
    startMonitor: async () => { smokeStarted = true; },
  }), /DESKTOP_MONITOR_GIT_FAILED/);
  assert.equal(smokeStarted, false);
  assert.deepEqual(smokeStages, ["MONITOR_GIT_CHECKING"]);

  let smokeGitCalls = 0;
  const successfulStages = [];
  await startMonitorAfterEnvironment({
    smoke: true,
    recordStage: (stage) => successfulStages.push(stage),
    verifyGitExecution: async () => { smokeGitCalls += 1; },
    startMonitor: async () => ({ origin: "http://127.0.0.1:4318" }),
  });
  assert.equal(smokeGitCalls, 1);
  assert.deepEqual(successfulStages, [
    "MONITOR_GIT_CHECKING",
    "MONITOR_GIT_VERIFIED",
    "MONITOR_STARTING",
  ]);
});

test("monitor diagnostics cannot overwrite an established production shell trace", () => {
  assert.equal(containsShellStageTrace("MONITOR_READY"), false);
  assert.equal(containsShellStageTrace("MONITOR_READY\nSHELL_WEB_IMPORTING"), true);
  assert.equal(containsShellStageTrace("PRIVATE_SHELL_WEB_IMPORTING"), false);
});

test("ASAR policy unpacks the monitor bundle, complete production build, and Sharp native files", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pomegr-asar-policy-"));
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

test("the web host and monitor environments exclude provider paths and credentials", () => {
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
    POMEGR_SMOKE_MAIN_STAGE_PATH: "safe-fixed-stage-path",
    PATH: [nodeDirectory, gitDirectory].join(path.delimiter),
    SystemRoot: "safe-system-root",
    TEMP: "safe-temp",
  };
  const runtime = minimalRuntimeEnvironment(source, {}, fileExists);
  assert.equal(runtime.PATH, gitDirectory);
  assert.equal(runtime.POMEGR_SMOKE_MAIN_STAGE_PATH, "safe-fixed-stage-path");
  assert.equal(executableOnPath(runtime, "git.exe", fileExists), true);
  assert.doesNotThrow(() => assertNoSystemNodeInPath(runtime, fileExists));
  assert.throws(() => assertNoSystemNodeInPath(source, fileExists), /DESKTOP_SYSTEM_NODE_VISIBLE/);
  for (const forbidden of ["APPDATA", "AUTH_HEADER", "CLAUDE_PROJECTS_DIR", "CODEX_HOME", "GH_TOKEN", "HOME", "OPENAI_API_KEY", "SERVICE_PAT", "SSH_AUTH_SOCK"]) {
    assert.equal(runtime[forbidden], undefined);
  }
  const webEnvironment = { ...source };
  keepOnlyRuntimeEnvironment(webEnvironment, { POMEGR_MONITOR_ORIGIN: "http://127.0.0.1:4317" }, fileExists);
  assert.equal(webEnvironment.PATH, gitDirectory);
  assert.equal(webEnvironment.POMEGR_MONITOR_ORIGIN, "http://127.0.0.1:4317");
  assert.equal(webEnvironment.POMEGR_SMOKE_MAIN_STAGE_PATH, "safe-fixed-stage-path");
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

test("desktop service bundling emits self-contained monitor and status-line workers", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pomegr-worker-bundle-"));
  try {
    await buildDesktopServiceBundles(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), fixtureRoot);
    const outputRoot = path.join(fixtureRoot, "desktop", "workers");
    assert.deepEqual(await readdir(outputRoot), ["claude-statusline-bridge.cjs", "monitor-host.cjs"]);
    const bundle = await readFile(path.join(outputRoot, "monitor-host.cjs"), "utf8");
    assert.match(bundle, /DESKTOP_MONITOR_START_FAILED/);
    assert.doesNotMatch(bundle, /from\s+["'](?:\.\/|\.\.\/)/);
    for (const forbidden of [
      "startPipelineTraceCaptureTransport", "pipeline-trace-transport",
      "createPipelineLogWriter", "pipeline-log-writer", "pipeline-log-stream", "pipeline-logs",
      "pomegr-pipeline-trace", "/internal/renderer-trace", "renderer-trace-contract", "renderer_event",
    ]) {
      assert.equal(bundle.includes(forbidden), false, forbidden);
    }
    const bridge = await readFile(path.join(outputRoot, "claude-statusline-bridge.cjs"), "utf8");
    assert.match(bridge, /captureClaudeStatuslineCost/);
    assert.doesNotMatch(bridge, /from\s+["'](?:\.\/|\.\.\/)/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
