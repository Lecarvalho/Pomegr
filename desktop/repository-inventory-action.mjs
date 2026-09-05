import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";

export const REPOSITORY_INVENTORY_CAPTURE_CHANNEL = "pomegr:capture-repository-context-inventory";
export const REPOSITORY_INVENTORY_CAPTURE_STATUSES = Object.freeze([
  "completed", "cancelled", "busy", "unavailable", "timed_out", "failed",
]);

const statusSet = new Set(REPOSITORY_INVENTORY_CAPTURE_STATUSES);

export function createRepositoryInventoryCaptureHandler(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = options.monitorOrigin;
  const authorizationToken = options.authorizationToken;
  return async (event, repositoryId, provider) => {
    if (!isTrustedEvent(event) || !/^repo-[a-f0-9]{24}$/u.test(repositoryId || "")
      || !["claude", "codex"].includes(provider) || typeof monitorOrigin !== "string" || !authorizationToken) return "unavailable";
    const params = new URLSearchParams({ repositoryId, provider });
    try {
      const response = await fetchImpl(`${monitorOrigin}/internal/repository-inventory/capture?${params}`, {
        method: "POST",
        cache: "no-store",
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken },
        signal: AbortSignal.timeout(40_000),
      });
      if (!response.ok) return "failed";
      const result = await response.json();
      return statusSet.has(result?.status) ? result.status : "failed";
    } catch { return "failed"; }
  };
}

export function installRepositoryInventoryCaptureIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Repository inventory capture requires ipcMain");
  ipcMain.removeHandler(REPOSITORY_INVENTORY_CAPTURE_CHANNEL);
  ipcMain.handle(REPOSITORY_INVENTORY_CAPTURE_CHANNEL, createRepositoryInventoryCaptureHandler(options));
  return () => ipcMain.removeHandler(REPOSITORY_INVENTORY_CAPTURE_CHANNEL);
}
