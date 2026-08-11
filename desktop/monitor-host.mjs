import { readFile } from "node:fs/promises";

import { startMonitorServer } from "../monitor/server.mjs";
import { environmentValue, MONITOR_PRIVATE_ENVIRONMENT_NAMES } from "./environment-policy.mjs";
import {
  assertPackagedElectronRuntime,
  installShutdown,
  recordUtilityStage,
  send,
} from "./runtime-proof.mjs";

const quietLogger = Object.freeze({ log() {} });
let handle;
const shutdown = installShutdown(async () => { await handle?.close(); });
recordUtilityStage("MONITOR_MODULE_LOADED");

async function installMonitorPrivateEnvironment() {
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

async function main() {
  try {
    recordUtilityStage("MONITOR_RUNTIME_ASSERTING");
    await assertPackagedElectronRuntime();
    recordUtilityStage("MONITOR_ENV_LOADING");
    await installMonitorPrivateEnvironment();
    recordUtilityStage("MONITOR_ENV_LOADED");
    recordUtilityStage("MONITOR_STARTING");
    handle = await startMonitorServer({
      host: "127.0.0.1",
      port: 0,
      logger: quietLogger,
    });
    const health = await fetch(`${handle.origin}/health`);
    if (health.status !== 204) throw new Error("DESKTOP_MONITOR_FETCH_FAILED");
    recordUtilityStage("MONITOR_READY");
    send({ type: "ready", service: "monitor", origin: handle.origin });
  } catch {
    send({ type: "failed", service: "monitor", code: "DESKTOP_MONITOR_START_FAILED" });
    await shutdown(1);
  }
}

void main();
