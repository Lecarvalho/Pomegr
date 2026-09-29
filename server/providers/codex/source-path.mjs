import fs from "node:fs";
import path from "node:path";

// Collapse Windows short names, junctions, and other aliases after discovery has
// established that a rollout belongs to the configured provider root.
export function canonicalCodexSourcePath(file) {
  const resolved = path.resolve(file);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

export function codexSourcePathKey(file) {
  const resolved = canonicalCodexSourcePath(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
