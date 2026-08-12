import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

import { startMonitorServer } from "../monitor/server.mjs";
import { createDefaultProviderRegistry } from "../monitor/providers/index.mjs";
import { environmentValue, MONITOR_PRIVATE_ENVIRONMENT_NAMES } from "./environment-policy.mjs";
import { startMonitorAfterEnvironment } from "./monitor-startup-policy.mjs";
import { installQuietConsole } from "./quiet-console.mjs";
import {
  assertPackagedElectronRuntime,
  installShutdown,
  recordUtilityStage,
  send,
  workerData,
} from "./runtime-proof.mjs";

const quietLogger = Object.freeze({ log() {} });
installQuietConsole();
let handle;
const shutdown = installShutdown(async () => { await handle?.close(); });
recordUtilityStage("MONITOR_MODULE_LOADED");

async function installMonitorPrivateEnvironment() {
  if (workerData?.privateEnvironment) {
    for (const name of MONITOR_PRIVATE_ENVIRONMENT_NAMES) {
      const value = workerData.privateEnvironment[name];
      if (typeof value === "string" && value) process.env[name] = value;
    }
    return;
  }
  const snapshotPath = environmentValue(process.env, "THREADLIGHT_SMOKE_MONITOR_ENV_PATH");
  if (!snapshotPath) throw new Error("DESKTOP_MONITOR_ENV_MISSING");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("DESKTOP_MONITOR_ENV_INVALID");
  }
  for (const name of MONITOR_PRIVATE_ENVIRONMENT_NAMES) {
    const value = snapshot[name];
    if (typeof value === "string" && value) process.env[name] = value;
  }
}

function verifyGitExecution() {
  return new Promise((resolve, reject) => {
    execFile("git", ["--version"], { windowsHide: true, timeout: 5_000 }, (error) => {
      if (error) reject(new Error("DESKTOP_MONITOR_GIT_FAILED"));
      else resolve();
    });
  });
}

async function main() {
  try {
    recordUtilityStage("MONITOR_RUNTIME_ASSERTING");
    await assertPackagedElectronRuntime({ smoke: workerData?.smoke === true });
    recordUtilityStage("MONITOR_ENV_LOADING");
    await installMonitorPrivateEnvironment();
    recordUtilityStage("MONITOR_ENV_LOADED");
    const smoke = workerData?.smoke === true;
    handle = await startMonitorAfterEnvironment({
      smoke,
      verifyGitExecution,
      recordStage: recordUtilityStage,
      startMonitor: () => startMonitorServer({
        host: "127.0.0.1",
        port: 0,
        authorizationToken: workerData?.authorizationToken,
        providerRegistry: createDefaultProviderRegistry(),
        logger: quietLogger,
      }),
    });
    const health = await fetch(`${handle.origin}/health`, {
      headers: workerData?.authorizationToken
        ? { "x-threadlight-desktop-authorization": workerData.authorizationToken }
        : undefined,
    });
    if (health.status !== 204) throw new Error("DESKTOP_MONITOR_FETCH_FAILED");
    recordUtilityStage("MONITOR_READY");
    send({
      type: "ready",
      service: "monitor",
      origin: handle.origin,
      ...(smoke ? { gitProof: "verified" } : {}),
    });
  } catch {
    send({ type: "failed", service: "monitor", code: "DESKTOP_MONITOR_START_FAILED" });
    await shutdown(1);
  }
}

void main();
