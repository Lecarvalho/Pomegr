import fs from "node:fs";
import path from "node:path";

const MAX_TRACKED_SOURCES = 8_192;
// A write stamped just before this process recorded its start still counts as a write.
const START_SLACK_MS = 2_000;

// Tells a content write from a `change` notification that altered nothing a reader can see.
export function createSourceWriteClassifier({ stat = (file) => fs.statSync(file, { throwIfNoEntry: false }), now = Date.now, maxEntries = MAX_TRACKED_SOURCES } = {}) {
  const seen = new Map();
  const startedAt = now();
  const keyOf = (file) => (process.platform === "win32" ? file.toLowerCase() : file);
  return Object.freeze({
    /**
     * @param {{target?: string, filename?: string | null, eventType?: string}} [change]
     * @returns {"written" | "unchanged" | "unverified"}
     */
    classify({ target, filename, eventType } = {}) {
      if (eventType !== "change" || typeof target !== "string" || typeof filename !== "string" || !filename) return "unverified";
      let file;
      let info;
      try {
        file = path.resolve(target, filename);
        info = stat(file);
      } catch { return "unverified"; }
      if (!info || typeof info.isFile !== "function" || !info.isFile()
        || !Number.isFinite(info.size) || !Number.isFinite(info.mtimeMs)) return "unverified";
      const key = keyOf(file);
      const previous = seen.get(key);
      seen.delete(key);
      seen.set(key, { size: info.size, mtimeMs: info.mtimeMs });
      if (seen.size > maxEntries) seen.delete(seen.keys().next().value);
      if (previous) return previous.size !== info.size || previous.mtimeMs !== info.mtimeMs ? "written" : "unchanged";
      return info.mtimeMs >= startedAt - START_SLACK_MS ? "written" : "unchanged";
    },
    clear() { seen.clear(); },
  });
}
