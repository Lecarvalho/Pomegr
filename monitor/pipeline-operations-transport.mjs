import { chmod, lstat, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_INTERVAL_MS = 500;
const MAX_BUFFERED_BYTES = 64 * 1024;
const DEFAULT_MAX_CLIENTS = 8;

export function pipelineOperationsEndpoint(port, {
  platform = process.platform,
  temporaryDirectory = os.tmpdir(),
  userId = typeof process.getuid === "function" ? process.getuid() : "user",
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Pipeline operations endpoint requires a concrete monitor port");
  }
  return platform === "win32"
    ? `\\\\.\\pipe\\pomegr-pipeline-${port}`
    : path.join(temporaryDirectory, `pomegr-pipeline-${String(userId).replace(/[^a-z0-9_-]/gi, "_")}-${port}.sock`);
}

async function removeUnixSocket(endpoint, platform) {
  if (platform === "win32") return;
  try {
    const status = await lstat(endpoint);
    if (!status.isSocket()) throw new Error("PIPELINE_OPERATIONS_ENDPOINT_COLLISION");
    await rm(endpoint, { force: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.message === "PIPELINE_OPERATIONS_ENDPOINT_COLLISION") throw error;
    throw new Error("PIPELINE_OPERATIONS_ENDPOINT_UNAVAILABLE");
  }
}

/** Start a local, read-only NDJSON feed for the manually launched operations CLI. */
export async function startPipelineOperationsTransport({
  port,
  snapshot,
  intervalMs = DEFAULT_INTERVAL_MS,
  endpoint = pipelineOperationsEndpoint(port),
  platform = process.platform,
  serverFactory = createServer,
  chmodSocket = chmod,
  maxClients = DEFAULT_MAX_CLIENTS,
} = {}) {
  if (typeof snapshot !== "function") throw new TypeError("Pipeline operations transport requires a snapshot function");
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    throw new TypeError("Pipeline operations interval must be between 100 and 60000 ms");
  }
  if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 64) {
    throw new TypeError("Pipeline operations client limit must be between 1 and 64");
  }
  await removeUnixSocket(endpoint, platform);

  const sockets = new Set();
  const server = serverFactory((socket) => {
    if (sockets.size >= maxClients) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let closed = false;
    const writeSnapshot = () => {
      if (closed || !socket.writable || socket.writableLength > MAX_BUFFERED_BYTES) return;
      try { socket.write(`${JSON.stringify(snapshot())}\n`); } catch { socket.destroy(); }
    };
    const timer = setInterval(writeSnapshot, intervalMs);
    timer.unref?.();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      sockets.delete(socket);
    };
    socket.once("close", close);
    socket.once("error", close);
    writeSnapshot();
  });

  await new Promise((resolve, reject) => {
    const onError = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(new Error("PIPELINE_OPERATIONS_START_FAILED"));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try { server.listen(endpoint); } catch { onError(); }
  });
  server.unref?.();
  if (platform !== "win32") {
    try {
      await chmodSocket(endpoint, 0o600);
    } catch {
      await new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
      await removeUnixSocket(endpoint, platform);
      throw new Error("PIPELINE_OPERATIONS_PERMISSION_FAILED");
    }
  }

  let closePromise;
  return Object.freeze({
    endpoint,
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        try { server.close(() => resolve()); } catch { resolve(); }
      }).finally(() => removeUnixSocket(endpoint, platform));
      return closePromise;
    },
  });
}
