import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import path from "node:path";

export const REPOSITORY_PLUGIN_ACTION_CHANNEL = "pomegr:repository-plugin-action";
export const REPOSITORY_PLUGIN_ACTION_STATUSES = Object.freeze([
  "completed", "cancelled", "busy", "unavailable", "timed_out", "failed", "changed",
]);

const STATUS_SET = new Set(REPOSITORY_PLUGIN_ACTION_STATUSES);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const ACTIONS = new Set(["recheck", "install", "update"]);
const PLUGIN_REF = /^(?:main|v\d{1,4}\.\d{1,4}\.\d{1,4}|[a-f0-9]{40})$/u;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,64})?$/u;
const SCOPES = new Set(["user", "project", "local"]);

function trustedMonitorOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "::1"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function query(repositoryId, provider, action) {
  return new URLSearchParams({ repositoryId, provider, ...(action ? { action } : {}) });
}

function safeStatus(value, fallback = "failed") {
  return STATUS_SET.has(value) ? value : fallback;
}

function validPlan(value, provider, action) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.provider !== provider || value.operation !== action
    || typeof value.root !== "string" || value.root.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.root) || !path.isAbsolute(value.root)
    || path.resolve(value.root).toLowerCase() !== value.root.toLowerCase()
    || typeof value.repositoryName !== "string" || value.repositoryName.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.repositoryName)
    || !SCOPES.has(value.scope) || !(value.currentVersion === null || (typeof value.currentVersion === "string" && VERSION.test(value.currentVersion)))
    || typeof value.targetVersion !== "string" || !VERSION.test(value.targetVersion)
    || typeof value.marketplaceRegistered !== "boolean" || typeof value.ref !== "string" || !PLUGIN_REF.test(value.ref)) return null;
  return Object.freeze({
    root: value.root,
    repositoryName: value.repositoryName,
    provider: value.provider,
    scope: value.scope,
    currentVersion: value.currentVersion,
    targetVersion: value.targetVersion,
    marketplaceRegistered: value.marketplaceRegistered,
    ref: value.ref,
    operation: value.operation,
  });
}

function plansMatch(left, right) {
  return Boolean(left && right) && left.root === right.root && left.repositoryName === right.repositoryName
    && left.provider === right.provider && left.scope === right.scope && left.currentVersion === right.currentVersion
    && left.targetVersion === right.targetVersion && left.marketplaceRegistered === right.marketplaceRegistered
    && left.ref === right.ref && left.operation === right.operation;
}

function verifiedSetup(result, targetVersion) {
  const setup = result?.setup;
  return result?.status === "completed" && setup?.readiness === "ready" && setup?.installation === "installed"
    && setup?.version === targetVersion;
}

/** Native-only bridge for repository plugin mutations. It deliberately returns only bounded status words. */
export function createRepositoryPluginAction(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const confirm = options.confirm || (async () => false);
  const runPlan = options.runPlan || (async () => "unavailable");
  const timeoutMs = options.timeoutMs ?? 40_000;
  let active = false;
  let disposed = false;

  async function request(endpoint, repositoryId, provider, action) {
    const response = await fetchImpl(`${monitorOrigin}/internal/repository-plugin/${endpoint}?${query(repositoryId, provider, action)}`, {
      method: "POST", cache: "no-store", headers: { [DESKTOP_AUTH_HEADER]: authorizationToken }, signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) return null;
    return response.json();
  }

  async function start(event, repositoryId, provider, action) {
    if (!isTrustedEvent(event) || !REPOSITORY_ID.test(repositoryId || "") || !PROVIDERS.has(provider) || !ACTIONS.has(action)
      || !monitorOrigin || !authorizationToken || disposed) return "unavailable";
    if (action !== "recheck" && active) return "busy";
    if (action === "recheck") {
      try { return safeStatus((await request("recheck", repositoryId, provider))?.status); } catch { return "failed"; }
    }
    active = true;
    try {
      const prepared = validPlan((await request("prepare", repositoryId, provider, action))?.plan, provider, action);
      if (!prepared) return "unavailable";
      if (await confirm(prepared) !== true || disposed) return "cancelled";
      const rechecked = validPlan((await request("prepare", repositoryId, provider, action))?.plan, provider, action);
      if (!plansMatch(prepared, rechecked)) return "changed";
      if (disposed) return "cancelled";
      const status = safeStatus(await runPlan(rechecked));
      if (status !== "completed" && status !== "failed" && status !== "timed_out") return status;
      const verified = await request("recheck", repositoryId, provider).catch(() => null);
      if (status !== "completed") return status;
      if (verifiedSetup(verified, rechecked.targetVersion)) return "completed";
      const setup = verified?.setup;
      return verified?.status === "completed" && setup?.readiness === "ready" && setup?.installation === "installed" ? "changed" : "failed";
    } catch (error) {
      return error?.name === "TimeoutError" ? "timed_out" : "failed";
    } finally {
      active = false;
    }
  }

  return Object.freeze({ start, dispose() { disposed = true; } });
}

export function installRepositoryPluginActionIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Repository plugin actions require ipcMain");
  ipcMain.removeHandler(REPOSITORY_PLUGIN_ACTION_CHANNEL);
  const action = options.action || createRepositoryPluginAction(options);
  ipcMain.handle(REPOSITORY_PLUGIN_ACTION_CHANNEL, async (event, repositoryId, provider, operation) => {
    try { return safeStatus(await action.start(event, repositoryId, provider, operation)); } catch { return "failed"; }
  });
  return () => { ipcMain.removeHandler(REPOSITORY_PLUGIN_ACTION_CHANNEL); action.dispose?.(); };
}
