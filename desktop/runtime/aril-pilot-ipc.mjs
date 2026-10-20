import path from "node:path";

import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { createArilPilot } from "./aril-pilot.mjs";

export const ARIL_PILOT_CHANNEL = "pomegr:aril-pilot";
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const unavailable = () => ({ ok: false, error: "unavailable" });

/** Trusted IPC and paired gateway transport for the desktop-owned pilot. */
export function installArilPilotIpc(options) {
  const { ipcMain, isTrustedEvent, chat, starter, dataRoot, authorizationToken } = options;
  let origin = null;
  try {
    const url = new URL(options.monitorOrigin);
    if (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) origin = url.origin;
  } catch { /* unavailable */ }
  const read = async (pathname) => {
    if (!origin || !authorizationToken) return null;
    try {
      const response = await (options.fetch || fetch)(`${origin}${pathname}`, {
        method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken },
      });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  const pilot = options.pilot || createArilPilot({
    directory: path.join(dataRoot, "agent-chat-v1", "pilot"),
    readBoard: (repositoryId) => read(`/api/tasks?${new URLSearchParams({ repositoryId })}`),
    readUsage: () => read("/api/usage-limits"),
    refreshUsage: options.refreshUsage,
    decide: (input) => chat.decidePilot(input), isBusy: () => chat.isBusy(), starter,
  });
  const handle = async (operation, payload, isAuthorized = async () => true) => {
    if (!["read", "activate", "pause", "revoke"].includes(operation)
      || !payload || typeof payload !== "object" || Array.isArray(payload)
      || !REPOSITORY_ID.test(payload.repositoryId ?? "")) return { ok: false, error: "invalid" };
    if (operation !== "activate" && Object.keys(payload).length !== 1) return { ok: false, error: "invalid" };
    try {
      if (Buffer.byteLength(JSON.stringify(payload)) > 16_384) return { ok: false, error: "invalid" };
      if (operation === "read") return await pilot.read(payload.repositoryId);
      return await (operation === "activate" ? pilot.activate(payload, isAuthorized) : pilot[operation](payload.repositoryId, isAuthorized));
    } catch { return unavailable(); }
  };
  ipcMain.removeHandler(ARIL_PILOT_CHANNEL);
  ipcMain.handle(ARIL_PILOT_CHANNEL, async (event, operation, payload) => {
    if (!isTrustedEvent?.(event)) return { ok: false, error: "desktop_only" };
    return handle(operation, payload);
  });
  pilot.start();
  const dispose = () => { ipcMain.removeHandler(ARIL_PILOT_CHANNEL); pilot.dispose(); };
  dispose.handlePaired = handle;
  return dispose;
}
