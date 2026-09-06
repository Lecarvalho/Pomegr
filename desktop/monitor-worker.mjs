import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

import { removeAgentQueryDescriptorIfTokenMatches } from "../shared/agent-query-transport.mjs";
import { stopChild } from "./utility-lifecycle.mjs";

/** The parent owns descriptor cleanup even when the worker cannot run shutdown. */
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
