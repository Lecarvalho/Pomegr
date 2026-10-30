// The one-time carry-over of the old per-repository paired-device permission to the global one. Until 2026-10-30 (Aril agent plan, phase 4) each
// repository had its own `pairedDevices` setting that let a paired device change that repository's memory and settings. Settings › Aril now
// has one permission for all repositories (`pairedOn` of the switch), so a repository that had it on makes the global permission start On, once.
//
// The stored per-repository values stay where they are and nothing reads them for permission any more; this module is their only reader. It
// keeps a marker file beside the switch (`<desktop data root>/aril-v1/paired-carried.json`). While the marker is absent, a pass reads every
// repository's board. When any says `pairedDevices: true` it writes the marker and then allows paired devices. When every board has been read and
// none says so, it only writes the marker. A board that cannot be read is tried again at the next delay and at the next start. The owner's own
// choice (`settle`) also ends the carry-over, so a permission the owner turned Off is never turned On again by it. The marker is written
// before the permission, so a failed write allows nothing. The permission stays false until all of this is done.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export const PAIRED_CARRY_FILE = "paired-carried.json";

// A pass runs at each delay after start: the monitor may still be starting or hydrating a board. The timers do not keep the process alive.
const DELAYS_MS = Object.freeze([15_000, 60_000, 300_000, 900_000]);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const VERSION = 1;

/**
 * `file` is the marker's absolute path, or none for a carry-over held in memory (a test). `arilSwitch` is the switch whose `pairedOn` it may set.
 * `filesystem` is a `node:fs/promises` stand-in.
 */
export function createPairedCarryOver({ file = null, arilSwitch, filesystem = fs, delaysMs = DELAYS_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file))) throw new TypeError("The paired carry-over needs an absolute file");
  if (!arilSwitch || typeof arilSwitch.setPairedOn !== "function") throw new TypeError("The paired carry-over needs the Aril switch");
  // `ended`: the marker exists or is being written. `chosen`: the owner set the permission, set at once and before anything is awaited, so
  // nothing after it widens what the owner chose.
  let ended = false;
  let chosen = false;
  let closed = false;
  const known = file === null ? Promise.resolve() : (async () => {
    try { if (JSON.parse(await filesystem.readFile(file, "utf8"))?.version === VERSION) ended = true; } catch { /* No marker: not carried yet. */ }
  })();
  let queue = Promise.resolve();
  const timers = new Set();

  async function writeMarker() {
    if (file === null) return true;
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await filesystem.mkdir(path.dirname(file), { recursive: true });
      await filesystem.writeFile(temporary, `${JSON.stringify({ version: VERSION })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await filesystem.rename(temporary, file);
      return true;
    } catch {
      await filesystem.unlink(temporary).catch(() => {});
      return false;
    }
  }

  /** The owner chose the permission, so the old values no longer count. Answers whether the marker was written. */
  async function settle() {
    chosen = true;
    ended = true;
    await known;
    return writeMarker();
  }

  async function pass({ readHome, readBoard }) {
    await known;
    await arilSwitch.ready;
    if (ended) return "done";
    let boards = null;
    try { const home = await readHome(); boards = Array.isArray(home?.boards) ? home.boards : null; } catch { /* Tried again later. */ }
    if (boards === null) return "later";
    let found = false;
    let complete = true;
    for (const entry of boards) {
      const repositoryId = entry?.repositoryId;
      if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) continue;
      let board = null;
      try { board = await readBoard(repositoryId); } catch { /* Tried again later. */ }
      if (ended || closed) return "done";
      const settings = board?.aril?.settings;
      if (settings === null || typeof settings !== "object") { complete = false; continue; }
      if (settings.pairedDevices === true) { found = true; break; }
    }
    if (ended || closed || (!found && !complete)) return ended ? "done" : "later";
    ended = true;
    if (!(await writeMarker())) { ended = chosen; return "later"; }
    if (found && !chosen && !arilSwitch.state().pairedOn) await arilSwitch.setPairedOn(true);
    return found && !chosen ? "carried" : "done";
  }

  /** One pass now, after any pass that is still running. Answers `done`, `carried` (the permission was set On), or `later` (a board could not be read, or the marker could not be written). */
  const run = (reads) => {
    const result = queue.then(() => pass(reads)).catch(() => "later");
    queue = result;
    return result;
  };
  const cancel = () => { closed = true; for (const timer of timers) clearTimer(timer); timers.clear(); };

  return Object.freeze({
    settle,
    run,
    /** A pass at each delay after start. A pass after the carry-over has ended does nothing. `cancel()` stops the ones still waiting. */
    start(reads) {
      for (const delay of delaysMs) {
        const timer = setTimer(() => { timers.delete(timer); if (!closed) void run(reads); }, delay);
        timer?.unref?.();
        timers.add(timer);
      }
      return Object.freeze({ cancel });
    },
    cancel,
  });
}
