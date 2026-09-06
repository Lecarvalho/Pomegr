import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monitorPort = 4317;
const webPort = 3003;
const execFileAsync = promisify(execFile);

class DevelopmentStartupError extends Error {}

export async function replaceDevelopmentServices({
  platform = process.platform,
  execFileFn = execFileAsync,
  logger = console,
} = {}) {
  if (platform !== "win32") return;
  try {
    const { stdout } = await execFileFn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(root, "scripts", "stop-dev-services.ps1"),
    ], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024,
      env: { ...process.env, POMEGR_DEV_LAUNCHER_PID: String(process.pid) },
    });
    if (/^\d+$/.test(stdout.trim()) && Number(stdout.trim()) > 0) {
      logger.log("[pomegr] Stopped the previous Pomegr development services.");
    }
  } catch (error) {
    const messages = {
      10: "Port 3003 is already in use by an unrecognized process. Close that app and retry.",
      11: "Port 4317 is already in use by an unrecognized process. Close that app and retry.",
      12: "Pomegr process ownership changed during cleanup. Retry npm run dev.",
    };
    throw new DevelopmentStartupError(messages[error.code] ??
      "Could not inspect or stop existing Pomegr development services. Close the previous instance and retry.");
  }
}

function isPortOpen(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(timeoutMs, () => settle(false));
  });
}

export async function assertDevelopmentPortsAvailable({ checkPortFn = isPortOpen } = {}) {
  const occupied = await Promise.all([
    checkPortFn(monitorPort, "127.0.0.1", 100),
    checkPortFn(webPort, "127.0.0.1", 100),
  ]);
  const ports = [monitorPort, webPort].filter((_, index) => occupied[index]);
  if (ports.length) throw new DevelopmentStartupError(`Development port ${ports.join(" / ")} is already in use. Close the app using it and retry.`);
}

export async function waitForPort(port, { host = "127.0.0.1", timeoutMs = 30_000, retryMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const remainingMs = Math.max(1, deadline - Date.now());
    if (await isPortOpen(port, host, Math.min(retryMs, remainingMs))) return;
    await delay(Math.min(retryMs, remainingMs));
  } while (Date.now() < deadline);
  throw new Error(`Local service on port ${port} did not become ready in time.`);
}

export async function prewarmDevelopmentServices({ waitForPortFn = waitForPort, fetchFn = fetch } = {}) {
  await Promise.all([
    waitForPortFn(monitorPort),
    waitForPortFn(webPort),
  ]);

  const response = await fetchFn(`http://127.0.0.1:${webPort}/api/state`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Development API prewarm failed.");
}

function hasExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function killChild(child, signal = "SIGTERM") {
  try {
    child.kill(signal);
  } catch {
    // The process already stopped.
  }
}

function waitForChildExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

function killWindowsTree(pid, { spawnFn, timeoutMs }) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawnFn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (succeeded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.removeAllListeners();
      resolve(succeeded);
    };
    const timer = setTimeout(() => {
      killChild(killer);
      finish(false);
    }, timeoutMs);
    killer.once("error", () => finish(false));
    killer.once("exit", (code) => finish(code === 0));
  });
}

export async function terminateChildTree(child, {
  platform = process.platform,
  spawnFn = spawn,
  timeoutMs = 2_000,
} = {}) {
  if (!child || hasExited(child)) return;

  if (platform === "win32" && Number.isSafeInteger(child.pid)) {
    const killed = await killWindowsTree(child.pid, { spawnFn, timeoutMs });
    if (killed) await waitForChildExit(child, Math.min(timeoutMs, 250));
    if (!hasExited(child)) killChild(child);
    return;
  }

  killChild(child);
  await waitForChildExit(child, timeoutMs);
  if (!hasExited(child)) killChild(child, "SIGKILL");
}

export async function startDev({
  spawnFn = spawn,
  replaceServicesFn = replaceDevelopmentServices,
  assertPortsAvailableFn = assertDevelopmentPortsAvailable,
  prewarmFn = prewarmDevelopmentServices,
  terminateFn = terminateChildTree,
  exitFn = (code) => process.exit(code),
  signalTarget = process,
  logger = console,
} = {}) {
  const children = [];

  let closing = false;
  let closePromise;
  function close(code) {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = Promise.allSettled(children.map((child) => Promise.resolve().then(() => terminateFn(child))))
      .then(() => exitFn(code));
    return closePromise;
  }

  let rejectLifecycleFailure;
  const lifecycleFailure = new Promise((_, reject) => {
    rejectLifecycleFailure = reject;
  });
  function failLifecycle() {
    if (closing) return;
    rejectLifecycleFailure(new Error("A development service stopped unexpectedly."));
    void close(1);
  }

  try {
    await replaceServicesFn({ logger });
    await assertPortsAvailableFn();
    const specs = [
      [process.execPath, [path.join(root, "monitor", "cli.mjs")]],
      [process.execPath, [path.join(root, "scripts", "run-vinext.mjs"), "dev", "--hostname", "0.0.0.0", "--port", String(webPort)]],
    ];
    for (const [command, args] of specs) {
      const child = spawnFn(command, args, { cwd: root, stdio: "inherit" });
      children.push(child);
      child.on("error", failLifecycle);
      child.on("exit", failLifecycle);
    }
  } catch (error) {
    logger.warn(error instanceof DevelopmentStartupError
      ? `[pomegr] ${error.message}`
      : "[pomegr] Development startup failed before services became ready.");
    await close(1);
    return false;
  }

  signalTarget.on("SIGINT", () => { void close(0); });
  signalTarget.on("SIGTERM", () => { void close(0); });

  try {
    await Promise.race([prewarmFn(), lifecycleFailure]);
    if (closing) return false;
    logger.log("[pomegr] Development services ready; API prewarmed.");
    return true;
  } catch {
    if (closing) {
      await closePromise;
      return false;
    }
    logger.warn("[pomegr] Startup prewarm did not complete; services continue normally.");
    return true;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startDev();
}
