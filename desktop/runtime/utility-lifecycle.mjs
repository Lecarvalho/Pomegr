export function waitForMessage(child, expectedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("DESKTOP_UTILITY_TIMEOUT"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type === "failed") {
        cleanup();
        reject(new Error(message.code || "DESKTOP_UTILITY_FAILED"));
      } else if (message?.type === expectedType) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("DESKTOP_UTILITY_EXITED"));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

export function waitForExit(child, timeoutMs) {
  if (!child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settleTimer;
    const timer = setTimeout(() => {
      clearTimeout(settleTimer);
      child.off("exit", onExit);
      reject(new Error("DESKTOP_UTILITY_EXIT_TIMEOUT"));
    }, timeoutMs);
    const confirmPidCleared = () => {
      if (!child.pid) {
        clearTimeout(timer);
        clearTimeout(settleTimer);
        resolve();
        return;
      }
      settleTimer = setTimeout(confirmPidCleared, 10);
    };
    const onExit = () => { confirmPidCleared(); };
    child.once("exit", onExit);
    if (!child.pid) {
      child.off("exit", onExit);
      clearTimeout(timer);
      clearTimeout(settleTimer);
      resolve();
    }
  });
}

export async function forceStopAndWait(child, options = {}) {
  const killTimeoutMs = options.killTimeoutMs ?? 5_000;
  const forceKill = options.forceKill || ((pid) => {
    if (typeof child.forceKill === "function") child.forceKill();
    else process.kill(pid, "SIGKILL");
  });
  if (!child.pid) return;

  const firstExit = waitForExit(child, killTimeoutMs);
  child.kill();
  try {
    await firstExit;
    return;
  } catch {
    const pid = child.pid;
    if (pid) {
      const forcedExit = waitForExit(child, killTimeoutMs);
      try { forceKill(pid); } catch { /* The process may have exited between checks. */ }
      await forcedExit;
    }
  }
}

export async function stopChild(child, options = {}) {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  if (!child.pid) return { forced: false };
  const stopped = waitForMessage(child, "stopped", gracefulTimeoutMs);
  const exited = waitForExit(child, gracefulTimeoutMs);
  try {
    if (typeof child.send === "function") child.send({ type: "shutdown" });
    else child.postMessage({ type: "shutdown" });
    await Promise.all([stopped, exited]);
    return { forced: false };
  } catch {
    await forceStopAndWait(child, options);
    return { forced: true };
  }
}
