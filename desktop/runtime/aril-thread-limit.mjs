// The size at which a repository's thread is flushed by itself: one global setting of the owner, kept by desktop main in one small file
// under the data root. It is a number of megabytes (2, 5, 10, or 25) or Never (0). A fresh install, a missing file, and a file outside the
// contract all read as 5 MB. Only the owner in the desktop window changes it; a paired device never does. It holds a size and nothing else.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export const THREAD_LIMIT_FILE = "thread-limit.json";
/** The values the owner may pick, in megabytes; 0 is Never. */
export const THREAD_LIMITS = Object.freeze([2, 5, 10, 25, 0]);
export const DEFAULT_THREAD_LIMIT = 5;
const MEGABYTE = 1024 * 1024;
const VERSION = 1;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `file` is an absolute path, or none for a setting held in memory. The value is read once at creation; `ready` settles when it has been,
 * and until then the setting is the default. `onChange(megabytes)` is called after each change that was kept.
 */
export function createThreadLimit({ file = null, filesystem = fs, onChange = () => {} } = {}) {
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file))) throw new TypeError("The thread limit needs an absolute file");
  let megabytes = DEFAULT_THREAD_LIMIT;
  let queue = Promise.resolve();

  const ready = file === null ? Promise.resolve() : (async () => {
    try {
      const parsed = JSON.parse(await filesystem.readFile(file, "utf8"));
      if (isPlainObject(parsed) && parsed.version === VERSION && THREAD_LIMITS.includes(parsed.megabytes)) megabytes = parsed.megabytes;
    } catch { /* No file or a file outside the contract: the default. */ }
  })();

  async function persist(value) {
    if (file === null) return true;
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await filesystem.mkdir(path.dirname(file), { recursive: true });
      await filesystem.writeFile(temporary, `${JSON.stringify({ version: VERSION, megabytes: value })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await filesystem.rename(temporary, file);
      return true;
    } catch {
      await filesystem.unlink(temporary).catch(() => {});
      return false;
    }
  }

  return Object.freeze({
    ready,
    /** The setting in megabytes (0 is Never). */
    megabytes: () => megabytes,
    /** The setting in bytes; 0 means the thread is never flushed by itself. */
    bytes: () => megabytes * MEGABYTE,
    /** Changes the setting. A value that could not be written is not kept. Answers `ok`, `invalid`, or `unavailable`. */
    set(value) {
      if (!THREAD_LIMITS.includes(value)) return Promise.resolve("invalid");
      const run = queue.then(async () => {
        await ready;
        if (value === megabytes) return "ok";
        if (!await persist(value)) return "unavailable";
        megabytes = value;
        try { onChange(value); } catch { /* A listener never stops the setting. */ }
        return "ok";
      });
      queue = run.catch(() => {});
      return run;
    },
  });
}
