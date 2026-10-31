// The one On/Off switch of Aril, global for the app and not for a repository. Desktop main owns it and keeps it in one small file under
// the desktop data root, so it survives a restart. Off wins at once and from anywhere: it is applied in memory before it is written,
// and a write that fails never turns Aril on. A change to On is written first and applied after, so an On the owner chose has a record.
// Only the owner turns it On: no Aril run, tool, queue, or monitor path reaches this module. Pomegr ships with Aril On: a missing file (a
// fresh install, or an owner who never touched the switch) reads as On. A file that is there but unreadable, damaged, or outside the
// contract reads as Off, because it may hold an owner's Off and a guess never overrides that. A switch with no file (a test, or a run
// with no data root) starts Off unless it is given its state, and every switch is Off until its file has been read.
//
// `pairedOn` is the owner's one permission for paired devices, for every repository: a paired device may then turn Aril On, and change the
// repositories' memory and Aril's settings. A paired device may always turn Aril Off and stop a grant. It is false until the owner allows it, or
// until the one-time carry-over of the old per-repository `pairedDevices` setting does (aril-paired-carry.mjs).

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export const ARIL_DIRECTORY = "aril-v1";
export const ARIL_SWITCH_FILE = "switch.json";

const VERSION = 1;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `file` is an absolute path, or none for a switch held in memory (a test, or a run with no data root). `initial` is the state of a switch
 * in memory. `filesystem` is a `node:fs/promises` stand-in. The state is read once at creation; `ready` settles when it has been.
 */
export function createArilSwitch({ file = null, filesystem = fs, initial = {} } = {}) {
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file))) throw new TypeError("The Aril switch needs an absolute file");
  let state = Object.freeze({ on: initial.on === true, pairedOn: initial.pairedOn === true });
  // Every Off bumps this, so an On that is still being written when an Off arrives never applies after it.
  let narrowings = 0;
  let queue = Promise.resolve();
  const listeners = new Set();

  const ready = file === null ? Promise.resolve() : (async () => {
    try {
      const parsed = JSON.parse(await filesystem.readFile(file, "utf8"));
      if (isPlainObject(parsed) && parsed.version === VERSION && typeof parsed.on === "boolean" && typeof parsed.pairedOn === "boolean") {
        state = Object.freeze({ on: parsed.on, pairedOn: parsed.pairedOn });
      }
    } catch (error) {
      // Only a file that is not there is an owner who never chose: Aril ships On. Any other failure may hide an Off, so it stays Off.
      if (error?.code === "ENOENT") state = Object.freeze({ on: true, pairedOn: false });
    }
  })();

  function apply(next) {
    if (next.on === state.on && next.pairedOn === state.pairedOn) return;
    state = Object.freeze({ on: next.on, pairedOn: next.pairedOn });
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* A listener never stops the switch. */ }
    }
  }

  async function persist(next) {
    if (file === null) return true;
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await filesystem.mkdir(path.dirname(file), { recursive: true });
      await filesystem.writeFile(temporary, `${JSON.stringify({ version: VERSION, on: next.on, pairedOn: next.pairedOn })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await filesystem.rename(temporary, file);
      return true;
    } catch {
      await filesystem.unlink(temporary).catch(() => {});
      return false;
    }
  }

  const enqueue = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  // A change that narrows what Aril may do (Off, or paired devices no longer allowed) applies in memory first and is written after, so it
  // takes effect at once. A change that widens it is written first and applies only when it was, and only if no narrowing came meanwhile.
  async function change(fields, narrows) {
    await ready;
    if (narrows) {
      narrowings += 1;
      apply({ ...state, ...fields });
      return (await enqueue(() => persist(state))) ? "ok" : "unavailable";
    }
    const seen = narrowings;
    return enqueue(async () => {
      const next = { ...state, ...fields };
      if (next.on === state.on && next.pairedOn === state.pairedOn) return "ok";
      if (!(await persist(next))) return "unavailable";
      if (seen !== narrowings) return "superseded";
      apply(next);
      return "ok";
    });
  }

  return Object.freeze({
    ready,
    /** Whether Aril is On now. False before the state has been read: a caller that must not meet the unread state awaits `ready` first. */
    isOn: () => state.on,
    state: () => state,
    /** Turns Aril On or Off. Answers `ok`, `unavailable` (the state could not be written; an Off still holds in memory), `superseded` (a newer change came first), or `invalid`. */
    set: (on) => (typeof on === "boolean" ? change({ on }, !on) : Promise.resolve("invalid")),
    /** Allows or forbids a paired device to turn Aril On. Answers as `set` does. */
    setPairedOn: (allowed) => (typeof allowed === "boolean" ? change({ pairedOn: allowed }, !allowed) : Promise.resolve("invalid")),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
