import { createPackageWithOptions, getRawHeader } from "@electron/asar";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_UNPACKED_FILES,
  DESKTOP_UNPACK_DIRECTORIES,
  unpackedFilesFromHeader,
} from "./asar-policy.mjs";
import { buildDesktopServiceBundles } from "./service-bundles.mjs";
import {
  executableOnPath,
  minimalRuntimeEnvironment,
  monitorPrivateEnvironment,
} from "./environment-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDirectories = ["dist", "monitor", "shared", "web"];
const desktopFiles = [
  "asar-policy.mjs",
  "bounded-lifecycle.mjs",
  "desktop-behavior.mjs",
  "environment-policy.mjs",
  "main.mjs",
  "monitor-host.mjs",
  "paths.mjs",
  "preload.cjs",
  "report-save.mjs",
  "runtime-proof.mjs",
  "security-policy.mjs",
  "settings.mjs",
  "shell-orchestrator.mjs",
  "shell-main.mjs",
  "smoke-main.mjs",
  "startup-error.mjs",
  "utility-lifecycle.mjs",
];
const runtimePackages = [
  "@img/colour",
  "@img/sharp-win32-x64",
  "detect-libc",
  "semver",
  "sharp",
  "vinext",
];
const CHILD_TIMEOUT_MS = 90_000;
const originalFs = createRequire(import.meta.url)("original-fs");
let childExitKind = "ELECTRON_EXIT_UNKNOWN";

function classifyElectronExit(result) {
  if (result.kind !== "exit") return `ELECTRON_${result.kind.replaceAll("-", "_").toUpperCase()}`;
  if (result.code === 0) return "ELECTRON_EXIT_ZERO";
  if (result.code === 0xc0000135 || result.code === -1073741515) return "ELECTRON_EXIT_MISSING_DLL";
  if (result.code === 0x80000003 || result.code === -2147483645) return "ELECTRON_EXIT_BREAKPOINT";
  if (result.code === 0xc0000409 || result.code === -1073740791) return "ELECTRON_EXIT_STACK_BUFFER";
  return "ELECTRON_EXIT_NONZERO";
}

function withTimeout(promise, timeoutMs, kind) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ kind, code: null }), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function copyRuntime(stagingRoot) {
  for (const directory of runtimeDirectories) {
    await cp(path.join(repositoryRoot, directory), path.join(stagingRoot, directory), { recursive: true });
  }
  await mkdir(path.join(stagingRoot, "desktop"), { recursive: true });
  for (const filename of desktopFiles) {
    await cp(path.join(repositoryRoot, "desktop", filename), path.join(stagingRoot, "desktop", filename));
  }
  for (const packageName of runtimePackages) {
    await cp(
      path.join(repositoryRoot, "node_modules", ...packageName.split("/")),
      path.join(stagingRoot, "node_modules", ...packageName.split("/")),
      { recursive: true },
    );
  }
  await writeFile(path.join(stagingRoot, "package.json"), JSON.stringify({
    name: "threadlight-desktop-smoke",
    version: "0.0.0",
    private: true,
    type: "module",
    main: "desktop/main.mjs",
  }), "utf8");
  await buildDesktopServiceBundles(repositoryRoot, stagingRoot);
}

async function createFixture(fixtureRoot) {
  const resourcesRoot = path.join(fixtureRoot, "resources");
  const stagingRoot = path.join(fixtureRoot, "staging");
  const archivePath = path.join(resourcesRoot, "app.asar");
  await mkdir(resourcesRoot, { recursive: true });
  await copyRuntime(stagingRoot);
  await createPackageWithOptions(stagingRoot, archivePath, {
    unpackDir: DESKTOP_UNPACK_DIRECTORIES,
  });

  const unpackedFiles = unpackedFilesFromHeader(getRawHeader(archivePath).header);
  const distFiles = [];
  for (const relativePath of await readdir(path.join(stagingRoot, "dist"), { recursive: true })) {
    if ((await stat(path.join(stagingRoot, "dist", relativePath))).isFile()) {
      distFiles.push(`dist/${relativePath.replaceAll("\\", "/")}`);
    }
  }
  const expectedUnpackedFiles = [...DESKTOP_UNPACKED_FILES, ...distFiles].sort();
  if (JSON.stringify(unpackedFiles) !== JSON.stringify(expectedUnpackedFiles)) {
    throw new Error("DESKTOP_ASAR_BOUNDARY_INVALID");
  }
  for (const relativePath of expectedUnpackedFiles) {
    await access(path.join(`${archivePath}.unpacked`, ...relativePath.split("/")));
  }
  return archivePath;
}

async function runElectron(archivePath, profileRoot, mainStagePath, monitorEnvironmentPath) {
  const environment = minimalRuntimeEnvironment(process.env, {
    THREADLIGHT_SMOKE_MAIN_STAGE_PATH: mainStagePath,
    THREADLIGHT_SMOKE_MONITOR_ENV_PATH: monitorEnvironmentPath,
    THREADLIGHT_SMOKE_PROFILE_ROOT: profileRoot,
  });
  if (!executableOnPath(environment, "git.exe")) throw new Error("DESKTOP_GIT_PATH_MISSING");
  const child = spawn(process.execPath, [
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-software-rasterizer",
    "--noerrdialogs",
    `--user-data-dir=${profileRoot}`,
    archivePath,
    "--smoke",
  ], {
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-8_192);
  });
  const exitResult = new Promise((resolve) => {
    child.once("error", () => resolve({ kind: "error", code: null }));
    child.once("exit", (code) => resolve({ kind: "exit", code }));
  });
  let result = await withTimeout(exitResult, CHILD_TIMEOUT_MS, "timeout");
  if (result.kind === "timeout") {
    child.kill();
    result = await withTimeout(exitResult, 5_000, "kill-timeout");
    if (result.kind === "kill-timeout") {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* The process may have exited between checks. */ }
      result = await withTimeout(exitResult, 5_000, "force-kill-timeout");
    }
  }
  childExitKind = classifyElectronExit(result);
  if (result.kind !== "exit" || result.code !== 0 || !output.includes("Threadlight desktop runtime compatibility: PASS")) {
    throw new Error("DESKTOP_CHILD_FAILED");
  }
}

let fixtureRoot;
let failureStage = "RUNNER_START";
async function writeStage(stage) {
  failureStage = stage;
  if (fixtureRoot) await writeFile(path.join(fixtureRoot, "stage"), stage, "utf8");
}

function removeFixture(target) {
  return new Promise((resolve, reject) => {
    originalFs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new Error("DESKTOP_BUNDLED_NODE_REQUIRED");
  }
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "threadlight-desktop-smoke-"));
  const profileRoot = path.join(fixtureRoot, "profile");
  const mainStagePath = path.join(fixtureRoot, "main-stage");
  const monitorEnvironmentPath = path.join(fixtureRoot, "monitor-environment.json");
  await Promise.all([
    mkdir(profileRoot, { recursive: true }),
    mkdir(path.join(profileRoot, "crash-dumps"), { recursive: true }),
    mkdir(path.join(profileRoot, "logs"), { recursive: true }),
    access(path.join(repositoryRoot, "dist", "server", "index.js")),
  ]);
  await writeFile(monitorEnvironmentPath, JSON.stringify(monitorPrivateEnvironment(process.env)), "utf8");
  await writeStage("STAGING_RUNTIME");
  const archivePath = await createFixture(fixtureRoot);
  await writeStage("ASAR_VERIFIED");
  await runElectron(archivePath, profileRoot, mainStagePath, monitorEnvironmentPath);
  await writeStage("CHILD_EXITED");
  console.log("Threadlight packaged desktop smoke: PASS");
} catch {
  if (fixtureRoot) {
    try {
      const recorded = (await readFile(path.join(fixtureRoot, "main-stage"), "utf8")).trim();
      if (/^[A-Z_]{1,40}$/.test(recorded)) failureStage = recorded;
    } catch { /* Retain the last runner-owned fixed stage. */ }
  }
  console.error(`Threadlight packaged desktop smoke: FAIL (DESKTOP_SMOKE_FAILED_${failureStage}_${childExitKind})`);
  process.exitCode = 1;
} finally {
  if (fixtureRoot) {
    try {
      await removeFixture(fixtureRoot);
    } catch {
      console.error("Threadlight packaged desktop smoke: FAIL (DESKTOP_FIXTURE_CLEANUP_FAILED)");
      process.exitCode = 1;
    }
  }
}
