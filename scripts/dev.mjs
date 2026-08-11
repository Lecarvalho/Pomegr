import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monitorPort = 4317;
const webPort = 3003;

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
  if (occupied.some(Boolean)) throw new Error("A Threadlight development port is already in use.");
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
    await assertPortsAvailableFn();
    const specs = [
      [process.execPath, [path.join(root, "monitor", "server.mjs")]],
      [process.execPath, [path.join(root, "scripts", "run-vinext.mjs"), "dev", "--hostname", "0.0.0.0", "--port", String(webPort)]],
    ];
    for (const [command, args] of specs) {
      const child = spawnFn(command, args, { cwd: root, stdio: "inherit" });
      children.push(child);
      child.on("error", failLifecycle);
      child.on("exit", failLifecycle);
    }
  } catch {
    logger.warn("[threadlight] Development startup failed before services became ready.");
    await close(1);
    return false;
  }

  signalTarget.on("SIGINT", () => { void close(0); });
  signalTarget.on("SIGTERM", () => { void close(0); });

  try {
    await Promise.race([prewarmFn(), lifecycleFailure]);
    if (closing) return false;
    logger.log("[threadlight] Development services ready; API prewarmed.");
    return true;
  } catch {
    if (closing) {
      await closePromise;
      return false;
    }
    logger.warn("[threadlight] Startup prewarm did not complete; services continue normally.");
    return true;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startDev();
}
