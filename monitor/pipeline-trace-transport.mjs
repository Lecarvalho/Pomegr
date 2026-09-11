import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

const MAX_AUTH_BYTES = 1_024;
const DEFAULT_CAPTURE_DURATION_MS = 600_000;

function safeUserId(value) {
  return String(value).replace(/[^a-z0-9_-]/giu, "_").slice(0, 64) || "user";
}

function concretePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Pipeline trace endpoint requires a concrete monitor port");
  }
  return port;
}

export function pipelineTraceCaptureEndpoint(port, { platform = process.platform } = {}) {
  concretePort(port);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32"
    ? `\\\\.\\pipe\\pomegr-pipeline-trace-${port}`
    : pathApi.join(os.tmpdir(), `pomegr-pipeline-trace-${safeUserId(typeof process.getuid === "function" ? process.getuid() : "user")}-${port}.sock`);
}

export function pipelineTraceCaptureDescriptor(port, {
  platform = process.platform,
  temporaryDirectory = platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Pomegr", "diagnostics")
    : os.tmpdir(),
  userId = typeof process.getuid === "function" ? process.getuid() : "user",
} = {}) {
  concretePort(port);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const directory = platform === "win32"
    ? temporaryDirectory
    : pathApi.join(temporaryDirectory, `pomegr-diagnostics-${safeUserId(userId)}`);
  return pathApi.join(directory, `pipeline-trace-${platform === "win32" ? "win" : "unix"}-${port}.json`);
}

function tokenEquals(expected, supplied) {
  if (typeof supplied !== "string" || supplied.length > 256) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function boundedDuration(value) {
  return Number.isInteger(value) && value >= 1_000 && value <= 10 * 60_000
    ? value : DEFAULT_CAPTURE_DURATION_MS;
}

async function writeDescriptor(descriptorPath, descriptor, { platform, mkdirDirectory = mkdir, write = writeFile, chmodFile = chmod } = {}) {
  await mkdirDirectory(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    const directory = await lstat(path.dirname(descriptorPath));
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
      throw new Error("PIPELINE_TRACE_DESCRIPTOR_DIRECTORY_UNSAFE");
    }
  }
  await write(descriptorPath, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (platform !== "win32") {
    await chmodFile(descriptorPath, 0o600);
    const file = await lstat(descriptorPath);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) throw new Error("PIPELINE_TRACE_DESCRIPTOR_UNSAFE");
  }
}

/**
 * Starts only when diagnostics are explicitly enabled. The descriptor and token are
 * private local transport setup, never an HTTP or browser-facing value.
 */
export async function startPipelineTraceCaptureTransport({
  enabled = false,
  port,
  recorder,
  endpoint = null,
  descriptorPath = null,
  captureDurationMs = DEFAULT_CAPTURE_DURATION_MS,
  platform = process.platform,
  serverFactory = createServer,
  token = randomBytes(32).toString("base64url"),
  mkdirDirectory = mkdir,
  write = writeFile,
  chmodFile = chmod,
} = {}) {
  if (!enabled) return null;
  if (!recorder || typeof recorder.activate !== "function" || typeof recorder.deactivate !== "function"
    || typeof recorder.snapshot !== "function") throw new TypeError("Pipeline trace transport requires a recorder");
  if (typeof token !== "string" || token.length < 32 || token.length > 256) {
    throw new TypeError("Pipeline trace transport token is invalid");
  }
  endpoint ||= pipelineTraceCaptureEndpoint(port, { platform });
  descriptorPath ||= pipelineTraceCaptureDescriptor(port, { platform });
  const durationLimit = boundedDuration(captureDurationMs);
  let activeSocket = null;
  let closed = false;
  const server = serverFactory((socket) => {
    if (closed || activeSocket) {
      socket.destroy();
      return;
    }
    activeSocket = socket;
    let authenticated = false;
    let completed = false;
    let input = "";
    let captureTimer = null;
    const authTimer = setTimeout(() => socket.destroy(), 5_000);
    authTimer.unref?.();
    const finish = (captureIncomplete) => {
      if (!authenticated || completed) return;
      completed = true;
      if (captureTimer) clearTimeout(captureTimer);
      recorder.deactivate({ captureIncomplete });
      try { socket.end(JSON.stringify(recorder.snapshot())); } catch { socket.destroy(); }
    };
    const close = () => {
      clearTimeout(authTimer);
      if (captureTimer) clearTimeout(captureTimer);
      if (authenticated && !completed) {
        recorder.deactivate({ captureIncomplete: true });
      }
      if (activeSocket === socket) activeSocket = null;
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_AUTH_BYTES) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!authenticated) {
        if (!message || message.type !== "authenticate" || !tokenEquals(token, message.token)) {
          socket.destroy();
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        recorder.activate();
        try { socket.write('{"type":"capturing"}\n'); } catch { socket.destroy(); return; }
        const requestedDuration = Number.isInteger(message.durationMs) && message.durationMs >= 1_000
          ? Math.min(durationLimit, message.durationMs) : durationLimit;
        captureTimer = setTimeout(() => finish(false), requestedDuration);
        captureTimer.unref?.();
        return;
      }
      if (!message || message.type !== "complete") {
        socket.destroy();
        return;
      }
      finish(false);
    });
    socket.once("error", close);
    socket.once("close", close);
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = () => {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
        reject(new Error("PIPELINE_TRACE_START_FAILED"));
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try { server.listen(endpoint); } catch { onError(); }
    });
  } catch { throw new Error("PIPELINE_TRACE_START_FAILED"); }
  if (platform !== "win32") {
    try { await chmod(endpoint, 0o600); } catch {
      await new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
      throw new Error("PIPELINE_TRACE_ENDPOINT_PERMISSION_FAILED");
    }
  }
  let descriptorCreated = false;
  try {
    await writeDescriptor(descriptorPath, { version: 1, endpoint, token }, { platform, mkdirDirectory, write, chmodFile });
    descriptorCreated = true;
  } catch {
    await new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
    throw new Error("PIPELINE_TRACE_DESCRIPTOR_FAILED");
  }
  server.unref?.();

  let closePromise;
  return Object.freeze({
    endpoint,
    descriptorPath,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      activeSocket?.destroy();
      closePromise = new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      }).finally(async () => {
        if (descriptorCreated) await rm(descriptorPath, { force: true }).catch(() => {});
      });
      return closePromise;
    },
  });
}
