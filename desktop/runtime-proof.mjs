import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort as workerParentPort, workerData } from "node:worker_threads";

export { workerData };

export const parentPort = process.parentPort;
export const resourceRoot = process.env.THREADLIGHT_RESOURCE_ROOT
  || process.env.THREADLIGHT_SMOKE_RESOURCE_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function send(message) {
  if (typeof process.send === "function") process.send(message);
  else if (parentPort) parentPort.postMessage(message);
  else workerParentPort?.postMessage(message);
}

export function recordUtilityStage(stage) {
  const stagePath = process.env.THREADLIGHT_SMOKE_MAIN_STAGE_PATH;
  if (!stagePath || !/^(?:MONITOR|WEB)_[A-Z_]{1,30}$/.test(stage)) return;
  try { writeFileSync(stagePath, stage, "utf8"); } catch { /* Diagnostics are best-effort. */ }
}

export async function assertPackagedElectronRuntime(options = {}) {
  if (!process.versions.electron || (options.smoke && !resourceRoot.includes(`${path.sep}app.asar`))) {
    throw new Error("DESKTOP_PACKAGED_ELECTRON_REQUIRED");
  }
  if (process.env.THREADLIGHT_SMOKE_NO_SYSTEM_NODE !== "1") {
    throw new Error("DESKTOP_NODE_GUARD_MISSING");
  }
  const searchPath = process.env.PATH || process.env.Path || "";
  if (searchPath.split(path.delimiter).filter(Boolean).some((directory) => existsSync(path.join(directory, "node.exe")))) {
    throw new Error("DESKTOP_SYSTEM_NODE_VISIBLE");
  }

  const packageMetadata = JSON.parse(await readFile(path.join(resourceRoot, "package.json"), "utf8"));
  if (!['threadlight', 'threadlight-desktop-smoke'].includes(packageMetadata.name)) {
    throw new Error("DESKTOP_RESOURCE_READ_FAILED");
  }
}

export function installShutdown(close) {
  let closing = false;
  const shutdown = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    await close();
    send({ type: "stopped" });
    setImmediate(() => process.exit(exitCode));
  };
  if (typeof process.send === "function") {
    process.on("message", (message) => {
      if (message?.type === "shutdown") void shutdown();
    });
  } else {
    if (parentPort) {
      parentPort.on("message", (event) => {
        if (event.data?.type === "shutdown") void shutdown();
      });
    } else {
      workerParentPort?.on("message", (message) => {
        if (message?.type === "shutdown") void shutdown();
      });
    }
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown(); });
  return shutdown;
}
