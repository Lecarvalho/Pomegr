import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function recordStartupStage(options, stage) {
  try { options.recordStage?.(stage); } catch { /* Diagnostics never affect service startup. */ }
}

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

async function loadBuildEntry(outDir, loadBuildEntryFn) {
  const entryPath = path.join(outDir, "server", "index.js");
  const entryStat = await stat(entryPath);
  const entryUrl = `${pathToFileURL(entryPath).href}?t=${entryStat.mtimeMs}`;
  return (loadBuildEntryFn || ((url) => import(url)))(entryUrl);
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

export function installStaticAssetFallback(server, serveStaticAsset) {
  const listeners = server.listeners("request");
  if (listeners.length !== 1 || typeof serveStaticAsset !== "function") {
    throw new LocalServiceError("WEB_STATIC_FALLBACK_FAILED");
  }
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    let pathname = "";
    try { pathname = new URL(request.url || "/", "http://127.0.0.1").pathname; } catch { /* The app handler returns its bounded response. */ }
    if (!pathname.startsWith("/assets/")) {
      listeners[0].call(server, request, response);
      return;
    }
    void serveStaticAsset(request, response, pathname).then((served) => {
      if (!served) listeners[0].call(server, request, response);
    }).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal Server Error");
    });
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
  recordStartupStage(options, "SHELL_WEB_OUT_DIR_VALIDATING");
  await requireBuild(outDir);
  recordStartupStage(options, "SHELL_WEB_OUT_DIR_READY");

  recordStartupStage(options, "SHELL_WEB_VINEXT_LOADING");
  let startProdServer;
  let serveStaticAsset;
  try {
    const loadProdServer = options.loadProdServerFn
      || (options.startProdServerFn
        ? async () => ({ startProdServer: options.startProdServerFn })
        : async () => import("vinext/server/prod-server"));
    const vinext = await loadProdServer();
    startProdServer = vinext?.startProdServer;
    const staticResponseHeaders = options.authorizationToken
      ? { ...(options.responseHeaders || {}), "Cache-Control": "no-store" }
      : undefined;
    serveStaticAsset = typeof vinext?.tryServeStatic === "function"
      ? (request, response, pathname) => vinext.tryServeStatic(
        request,
        response,
        path.join(outDir, "client"),
        pathname,
        false,
        undefined,
        staticResponseHeaders,
      )
      : async () => false;
    if (typeof startProdServer !== "function") throw new Error("WEB_VINEXT_RUNTIME_INVALID");
    if (!options.loadProdServerFn && !options.startProdServerFn && typeof vinext?.tryServeStatic !== "function") {
      throw new Error("WEB_VINEXT_STATIC_RUNTIME_INVALID");
    }
  } catch {
    throw new LocalServiceError("WEB_START_FAILED");
  }
  recordStartupStage(options, "SHELL_WEB_VINEXT_LOADED");

  recordStartupStage(options, "SHELL_WEB_ENTRY_LOADING");
  try {
    const entry = await loadBuildEntry(outDir, options.loadBuildEntryFn);
    const handler = entry?.default;
    if (typeof handler !== "function" && typeof handler?.fetch !== "function") {
      throw new Error("WEB_BUILD_ENTRY_INVALID");
    }
  } catch {
    throw new LocalServiceError("WEB_START_FAILED");
  }
  recordStartupStage(options, "SHELL_WEB_ENTRY_READY");

  const previousMonitorOrigin = process.env.THREADLIGHT_MONITOR_ORIGIN;
  process.env.THREADLIGHT_MONITOR_ORIGIN = monitorOrigin;
  let result;
  let handle;
  try {
    recordStartupStage(options, "SHELL_WEB_LISTENER_STARTING");
    result = await startProdServer({ host, port, outDir });
    if (!result?.server?.listening) throw new LocalServiceError("WEB_START_FAILED");
    recordStartupStage(options, "SHELL_WEB_LISTENER_READY");
    const boundPort = result.server.address()?.port;
    installStaticAssetFallback(result.server, serveStaticAsset);
    if (options.authorizationToken) {
      installLocalRequestGate(result.server, {
        authorizationToken: options.authorizationToken,
        host,
        port: boundPort,
        responseHeaders: options.responseHeaders,
      });
    }
    recordStartupStage(options, "SHELL_WEB_AUTH_READY");
    handle = createLocalServiceHandle(result.server, {
      host,
      normalExitCode: "WEB_CLOSED",
      unexpectedExitCode: "WEB_EXIT_UNEXPECTED",
      onClose() {
        if (previousMonitorOrigin === undefined) delete process.env.THREADLIGHT_MONITOR_ORIGIN;
        else process.env.THREADLIGHT_MONITOR_ORIGIN = previousMonitorOrigin;
      },
    });
    recordStartupStage(options, "SHELL_WEB_HANDLE_READY");
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
