import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_PLUGIN_SETUP_FILE_BYTES = 512 * 1024;
export const MAX_PLUGIN_SETUP_ENTRIES = 64;

export function pluginSetupHome(options = {}) {
  const environment = options.env || options.environment || process.env;
  return options.homeDir || environment.HOME || environment.USERPROFILE || os.homedir();
}

export function canonicalDirectory(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  try { return path.resolve(value); } catch { return null; }
}

export function samePath(left, right) {
  const a = canonicalDirectory(left);
  const b = canonicalDirectory(right);
  if (!a || !b) return false;
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function boundedVersion(value) {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : null;
}

export async function readBounded(file, options = {}) {
  const readFile = options.readFile;
  try {
    const maxBytes = options.maxBytes || MAX_PLUGIN_SETUP_FILE_BYTES;
    if (readFile) {
      const value = await readFile(file, "utf8");
      const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : null;
      if (text === null || Buffer.byteLength(text, "utf8") > maxBytes) return { status: "invalid", text: null };
      return { status: "ready", text };
    }
    const handle = await fs.open(file, "r");
    try {
      const chunks = [];
      let total = 0;
      while (total <= maxBytes) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead <= 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        total += bytesRead;
        if (total > maxBytes) return { status: "invalid", text: null };
      }
      return { status: "ready", text: Buffer.concat(chunks, total).toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unavailable", text: null };
  }
}

export function parseJsonText(text) {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function readTomlSection(text, sectionName) {
  if (typeof text !== "string" || typeof sectionName !== "string") return null;
  const lines = text.split(/\r?\n/);
  let active = false;
  let found = false;
  let invalid = false;
  const seenKeys = new Set();
  const allowedKeys = sectionName.startsWith("plugins.")
    ? new Set(["enabled"])
    : sectionName.startsWith("marketplaces.")
      ? new Set(["source_type", "source", "ref", "last_updated", "last_revision"])
      : null;
  const values = Object.create(null);
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      if (active && section[1].trim() === sectionName) invalid = true;
      if (section[1].trim().startsWith(`${sectionName}.`)) invalid = true;
      active = section[1].trim() === sectionName;
      if (active) found = true;
      continue;
    }
    if (/^\s*\[/.test(line) && !/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)
      && line.includes(sectionName.split(".")[0])) {
      invalid = true;
      continue;
    }
    if (!active) continue;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!match) { invalid = true; continue; }
    if (seenKeys.has(match[1]) || (allowedKeys && !allowedKeys.has(match[1]))) { invalid = true; continue; }
    seenKeys.add(match[1]);
    const raw = match[2].trim();
    if (raw === "true" || raw === "false") values[match[1]] = raw === "true";
    else if (raw.startsWith("{") && raw.endsWith("}")) {
      const table = Object.create(null);
      const nestedKeys = new Set();
      for (const part of raw.slice(1, -1).split(",")) {
        if (!part.trim()) continue;
        const item = part.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*$/);
        if (item && ["type", "url", "ref"].includes(item[1]) && !nestedKeys.has(item[1])) {
          nestedKeys.add(item[1]);
          table[item[1]] = item[2] ?? item[3];
        }
        else invalid = true;
      }
      values[match[1]] = table;
    } else {
      const quoted = raw.match(/^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/);
      if (quoted) values[match[1]] = quoted[1] ?? quoted[2];
      else invalid = true;
    }
  }
  if (!found && !invalid) return null;
  if (invalid) Object.defineProperty(values, "__invalid", { value: true, enumerable: false });
  return values;
}

export async function listBoundedDirectories(directory, options = {}) {
  const readDir = options.readDir;
  try {
    let entries;
    if (readDir) {
      entries = await readDir(directory, { withFileTypes: true });
      if (!Array.isArray(entries) || entries.length > MAX_PLUGIN_SETUP_ENTRIES) return { status: "invalid", entries: [] };
    } else {
      const handle = await fs.opendir(directory);
      entries = [];
      try {
        for await (const entry of handle) {
          entries.push(entry);
          if (entries.length > MAX_PLUGIN_SETUP_ENTRIES) return { status: "invalid", entries: [] };
        }
      } finally {
        try { await handle.close(); } catch { /* Async iteration may have closed it. */ }
      }
    }
    return {
      status: "ready",
      entries: entries.filter((entry) => entry?.isDirectory?.() && typeof entry.name === "string"),
    };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unavailable", entries: [] };
  }
}
