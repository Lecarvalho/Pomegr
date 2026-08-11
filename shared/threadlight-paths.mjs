import os from "node:os";
import path from "node:path";

function environmentValue(environment, name) {
  const key = Object.keys(environment || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

export function resolveThreadlightDataRoot(options = {}) {
  const environment = options.environment || process.env;
  const configured = environmentValue(environment, "THREADLIGHT_DATA_DIR");
  if (configured) return path.resolve(configured);
  const platform = options.platform || process.platform;
  const appData = environmentValue(environment, "APPDATA");
  if (platform === "win32" && appData) return path.resolve(appData, "threadlight");
  return path.resolve(options.homeDir || os.homedir(), ".threadlight");
}
