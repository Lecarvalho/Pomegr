import path from "node:path";

import { resolvePomegrDataRoot } from "../shared/pomegr-paths.mjs";
import { environmentValue } from "./environment-policy.mjs";

function absolute(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(code);
  return path.resolve(value);
}

export function resolveDesktopPaths(options) {
  const environment = options.environment || {};
  const applicationRoot = absolute(options.appPath, "DESKTOP_APP_PATH_INVALID");
  const resourcesRoot = absolute(options.resourcesPath, "DESKTOP_RESOURCES_PATH_INVALID");
  const unpackedRoot = applicationRoot.endsWith(`${path.sep}app.asar`)
    ? `${applicationRoot}.unpacked`
    : applicationRoot;
  const portableRoot = environmentValue(environment, "PORTABLE_EXECUTABLE_DIR");
  const installedDataRoot = absolute(options.userDataPath, "DESKTOP_USER_DATA_PATH_INVALID");
  const dataRoot = desktopUserDataOverride(environment) || installedDataRoot;

  return Object.freeze({
    mode: portableRoot ? "portable" : "installed",
    applicationRoot,
    resourcesRoot,
    unpackedRoot,
    dataRoot,
    settingsFile: path.join(dataRoot, "settings.json"),
    cacheRoot: path.join(dataRoot, "cache"),
    costSnapshotsRoot: path.join(dataRoot, "cost-snapshots"),
  });
}

export function desktopUserDataOverride(environment = {}) {
  const portableRoot = environmentValue(environment, "PORTABLE_EXECUTABLE_DIR");
  if (portableRoot) return path.resolve(portableRoot, "PomegrData");
  const configuredDataRoot = environmentValue(environment, "POMEGR_DATA_DIR");
  return configuredDataRoot ? path.resolve(configuredDataRoot) : null;
}

export function defaultDesktopDataRoot(options = {}) {
  return resolvePomegrDataRoot(options);
}
