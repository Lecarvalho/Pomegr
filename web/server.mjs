import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProdServer } from "vinext/server/prod-server";
import { requestHasDesktopAuthorization, requireDesktopToken } from "../shared/local-auth.mjs";
import {
  closeServer,
  createLocalServiceHandle,
  LocalServiceError,
  requireLoopbackHost,
  requirePort,
  safeServiceError,
} from "../shared/local-service.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(ROOT, "dist");

function requireMonitorOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new LocalServiceError("WEB_INVALID_MONITOR_ORIGIN");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash || !["127.0.0.1", "[::1]"].includes(parsed.hostname)
    || !parsed.port) {
    throw new LocalServiceError("WEB_INVALID_MONITOR_ORIGIN");
  }
  return parsed.origin;
}

async function requireBuild(outDir) {
  try {
    await access(path.join(outDir, "server", "index.js"));
    await access(path.join(outDir, "client"));
  } catch {
    throw new LocalServiceError("WEB_BUILD_MISSING");
  }
}

export function installLocalRequestGate(server, options) {
  const authorizationToken = requireDesktopToken(options.authorizationToken, "WEB_INVALID_AUTHORIZATION");
  const expectedHost = `${options.host}:${options.port}`;
  const expectedOrigin = `http://${expectedHost}`;
  const responseHeaders = Object.freeze({ ...(options.responseHeaders || {}) });
  const listeners = server.listeners("request");
  if (listeners.length !== 1) throw new LocalServiceError("WEB_REQUEST_GATE_FAILED");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
    const allowed = ["GET", "HEAD"].includes(request.method || "")
      && request.headers.host === expectedHost
      && (!origin || origin === expectedOrigin)
      && requestHasDesktopAuthorization(request, authorizationToken);
    response.setHeader("Cache-Control", "no-store");
    for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value);
    if (!allowed) {
      response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Unauthorized");
      return;
    }
    listeners[0].call(server, request, response);
  });
}

export async function startWebServer(options = {}) {
  const host = requireLoopbackHost(options.host ?? "127.0.0.1", "WEB_INVALID_HOST");
  const port = requirePort(options.port ?? 0, "WEB_INVALID_PORT");
  const monitorOrigin = requireMonitorOrigin(options.monitorOrigin ?? "http://127.0.0.1:4317");
  let outDir;
  try {
    outDir = path.resolve(options.outDir ?? DEFAULT_OUT_DIR);
  } catch {
    throw new LocalServiceError("WEB_INVALID_BUILD_PATH");
  }
  await requireBuild(outDir);

  const previousMonitorOrigin = process.env.THREADLIGHT_MONITOR_ORIGIN;
  process.env.THREADLIGHT_MONITOR_ORIGIN = monitorOrigin;
  let result;
  let handle;
  try {
    result = await (options.startProdServerFn || startProdServer)({ host, port, outDir });
    if (!result?.server?.listening) throw new LocalServiceError("WEB_START_FAILED");
    const boundPort = result.server.address()?.port;
    if (options.authorizationToken) {
      installLocalRequestGate(result.server, {
        authorizationToken: options.authorizationToken,
        host,
        port: boundPort,
        responseHeaders: options.responseHeaders,
      });
    }
    handle = createLocalServiceHandle(result.server, {
      host,
      normalExitCode: "WEB_CLOSED",
      unexpectedExitCode: "WEB_EXIT_UNEXPECTED",
      onClose() {
        if (previousMonitorOrigin === undefined) delete process.env.THREADLIGHT_MONITOR_ORIGIN;
        else process.env.THREADLIGHT_MONITOR_ORIGIN = previousMonitorOrigin;
      },
    });
    options.logger?.log?.(`[threadlight] Web server ready on ${handle.origin}.`);
    return handle;
  } catch (error) {
    if (handle) await handle.close();
    else await closeServer(result?.server);
    if (!handle) {
      if (previousMonitorOrigin === undefined) delete process.env.THREADLIGHT_MONITOR_ORIGIN;
      else process.env.THREADLIGHT_MONITOR_ORIGIN = previousMonitorOrigin;
    }
    throw safeServiceError(error, "WEB_START_FAILED");
  }
}
