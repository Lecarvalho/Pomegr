import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

import { removeAgentQueryDescriptorIfTokenMatches } from "../../shared/agent-query-transport.mjs";
import { stopChild } from "./utility-lifecycle.mjs";

export function refreshClaudeUsageAfterSignIn(child, timeoutMs = 15_000) {
  return refreshUsageAfterSignIn(child, "claude", timeoutMs);
}

export function refreshCodexUsageAfterSignIn(child, timeoutMs = 15_000) {
  return refreshUsageAfterSignIn(child, "codex", timeoutMs);
}

function refreshUsageAfterSignIn(child, provider, timeoutMs) {
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    const onMessage = (message) => {
      if (message?.type === `${provider}-usage-rechecked`) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.on("message", onMessage);
    child.once("exit", finish);
    child.once("error", finish);
    try { child.postMessage({ type: `${provider}-sign-in-completed` }); } catch { finish(); }
  });
}

let sessionWindowOwnerRequests = 0;
let pilotUsageRequests = 0;

/** Ordinary acquisition at a pilot wait/reset deadline. No browser route or sign-in bypass. */
export function refreshPilotUsage(child, timeoutMs = 15_000) {
  if (!child) return Promise.resolve();
  pilotUsageRequests = (pilotUsageRequests + 1) % Number.MAX_SAFE_INTEGER;
  const requestId = pilotUsageRequests;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    const onMessage = (message) => {
      if (message?.type === "pilot-usage-refreshed" && message.requestId === requestId) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.on("message", onMessage);
    child.once("exit", finish);
    child.once("error", finish);
    try { child.postMessage({ type: "pilot-usage-refresh", requestId }); } catch { finish(); }
  });
}

/** Ask the monitor for the live session's unique owning process. Desktop-main only; null when unknown. */
export function requestSessionWindowOwner(child, sessionId, timeoutMs = 2_000) {
  if (!child || typeof sessionId !== "string") return Promise.resolve(null);
  sessionWindowOwnerRequests = (sessionWindowOwnerRequests + 1) % Number.MAX_SAFE_INTEGER;
  const requestId = sessionWindowOwnerRequests;
  return new Promise((resolve) => {
    const finish = (owner) => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", unavailable);
      child.removeListener("error", unavailable);
      resolve(owner);
    };
    const unavailable = () => finish(null);
    const onMessage = (message) => {
      if (message?.type !== "session-window-owner-result" || message.requestId !== requestId) return;
      const owner = message.owner;
      finish(owner && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.processStartIdentity === "string"
        ? { pid: owner.pid, processStartIdentity: owner.processStartIdentity,
          windowTitles: (Array.isArray(owner.windowTitles) ? owner.windowTitles : []).filter((title) => typeof title === "string").slice(0, 2) }
        : null);
    };
    const timer = setTimeout(unavailable, timeoutMs);
    child.on("message", onMessage);
    child.once("exit", unavailable);
    child.once("error", unavailable);
    try { child.postMessage({ type: "session-window-owner", requestId, sessionId }); } catch { unavailable(); }
  });
}

export function createMonitorWorker(entrypoint, options) {
  const { agentQueryDescriptorPath: descriptorPath, agentAuthorizationToken: token } = options.workerData;
  const worker = new Worker(entrypoint, options);
  const child = new EventEmitter();
  let alive = true;
  Object.defineProperty(child, "pid", { get: () => alive ? worker.threadId : undefined });
  child.send = (message) => worker.postMessage(message);
  child.postMessage = child.send;
  child.kill = () => { void worker.terminate(); return true; };
  child.forceKill = child.kill;
  worker.once("online", () => child.emit("spawn"));
  worker.on("message", (message) => child.emit("message", message));
  worker.once("error", () => child.emit("error", new Error("DESKTOP_MONITOR_FAILED")));
  const cleanupComplete = new Promise((resolve) => {
    worker.once("exit", (code) => {
      alive = false;
      // The worker has exited, so it cannot publish again after this cleanup.
      void removeAgentQueryDescriptorIfTokenMatches({ descriptorPath, token }).then(resolve, () => resolve(false));
      child.emit("exit", code);
    });
  });
  child.stop = async (stopOptions) => {
    try {
      return await stopChild(child, stopOptions);
    } finally {
      if (!alive) await cleanupComplete;
    }
  };
  return child;
}
