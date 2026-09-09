import path from "node:path";

export const EMPTY_PROVIDER_FOLDERS = Object.freeze({
  folders: Object.freeze({ claudeConfigDir: null, claudeProjectsDir: null, codexHome: null }),
});

export function safeProviderFolder(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(value) || !path.isAbsolute(value)) return null;
  return path.normalize(value);
}

/** Capture provider-owned roots once; serving reads must never acquire providers. */
export function createProviderFoldersSnapshot(providers) {
  const folders = { ...EMPTY_PROVIDER_FOLDERS.folders };
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (provider?.id === "claude") {
      folders.claudeConfigDir = safeProviderFolder(provider.providerFolders?.claudeConfigDir);
      folders.claudeProjectsDir = safeProviderFolder(provider.providerFolders?.claudeProjectsDir);
    } else if (provider?.id === "codex") {
      folders.codexHome = safeProviderFolder(provider.providerFolders?.codexHome);
    }
  }
  return Object.freeze({ folders: Object.freeze(folders) });
}
