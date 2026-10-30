// Aril's own controls, held by desktop main beside the chat: the One On/Off switch, the owner's memory, and the space each thread takes
// on disk with its flush. The chat's `handle` serves these operations to the desktop window and, for the few a paired device may use, to a
// paired device through the LAN gateway. Aril itself reaches none of them: no provider run, tool, queue, or monitor path turns the
// switch On or changes a memory.
//
// Who may do what:
// - The switch: anyone may read it. The desktop window turns it On or Off. A paired device may always turn it Off (a stop is always
//   allowed, as a grant's is), and may turn it On only when the owner allowed paired devices on the desktop (`aril_paired_on_set`). That one
//   permission, `pairedOn`, is also what lets a paired device change a repository's memory and Aril's settings; `pairedAllowed` answers it.
// - The owner's memory: anyone may read it; only the desktop window edits it. Aril keeps it current through one fixed update that desktop
//   main validates (agent-chat-memory.mjs); the operations here are not that path.
// - The thread space, the limit ("Flush oldest at"), and the owner's flush: the desktop window only.
// - With Aril Off, every write below is refused (`conflict`): the owner's memory, the limit, and the owner's flush. Reads still answer. The
//   automatic flush is not one of them: it is desktop housekeeping, not an action of Aril, and keeps running.

import path from "node:path";

import { createArilSwitch, ARIL_DIRECTORY, ARIL_SWITCH_FILE } from "./aril-switch.mjs";
import { createPairedCarryOver, PAIRED_CARRY_FILE } from "./aril-paired-carry.mjs";
import { createOwnerMemory, OWNER_MEMORY_FILE } from "./aril-owner-memory.mjs";
import { createThreadLimit, THREAD_LIMIT_FILE } from "./aril-thread-limit.mjs";
import { AGENT_CHAT_DIRECTORY } from "./agent-chat-store.mjs";
import { createThreadSpace } from "./agent-chat-space.mjs";

export const ARIL_CONTROL_OPERATIONS = Object.freeze(["aril_switch", "aril_switch_set", "aril_paired_on_set", "owner_memory", "owner_memory_set", "thread_space", "thread_limit_set", "thread_flush"]);

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const refused = (error) => Object.freeze({ ok: false, error });
const INVALID = refused("invalid");
const UNAVAILABLE = refused("unavailable");
const DESKTOP_ONLY = refused("desktop_only");
// A write while Aril is Off: Settings shows everything below the switch read only, and desktop main holds the same line.
const WHILE_OFF = refused("conflict");
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactly = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/**
 * `dataRoot` holds the switch, the owner's memory, and the thread limit (`<dataRoot>/aril-v1/`) and the threads (`<dataRoot>/agent-chat-v1/`).
 * Tests give `arilSwitch`, `ownerMemory`, `threadLimit`, `space`, and `pairedCarry` of their own. `busy(repositoryId)` says whether a turn of the repository
 * runs or waits, and `onOff()` is called each time the switch turns Off, to drop what Off must not run.
 */
export function createArilControl({ dataRoot = null, arilSwitch, ownerMemory, threadLimit, space, pairedCarry, store, images, busy = () => false, onOff = () => {}, now } = {}) {
  const held = arilSwitch ?? createArilSwitch(dataRoot ? { file: path.join(dataRoot, ARIL_DIRECTORY, ARIL_SWITCH_FILE) } : {});
  // The one-time carry-over of the old per-repository permission. A control with no data root keeps no marker and carries nothing.
  const carry = pairedCarry ?? (dataRoot ? createPairedCarryOver({ file: path.join(dataRoot, ARIL_DIRECTORY, PAIRED_CARRY_FILE), arilSwitch: held }) : null);
  const memory = ownerMemory ?? createOwnerMemory({ ...(dataRoot ? { file: path.join(dataRoot, ARIL_DIRECTORY, OWNER_MEMORY_FILE) } : {}), ...(now ? { now: () => now().getTime() } : {}) });
  // A new limit is judged at once for every thread: one that is over it and idle is flushed now.
  let threads = null;
  const limit = threadLimit ?? createThreadLimit({ ...(dataRoot ? { file: path.join(dataRoot, ARIL_DIRECTORY, THREAD_LIMIT_FILE) } : {}), onChange: () => { void threads?.sweep(); } });
  threads = space ?? (dataRoot && store ? createThreadSpace({ directory: path.join(dataRoot, AGENT_CHAT_DIRECTORY), store, images, busy, limit: () => limit.bytes() }) : null);
  held.subscribe((state) => { if (!state.on) onOff(); });

  const desktop = (origin) => Boolean(origin?.event);
  // The switch is read before the first write it judges, so a write at start never meets an Off that is only the unread state.
  const isOff = async () => { await held.ready; return !held.isOn(); };
  // Whether the owner allows paired devices: the one global permission. False until the switch has been read.
  const pairedAllowed = async () => { await held.ready; return held.state().pairedOn === true; };
  const memoryAnswer = (answer) => (answer.ok ? answer : refused(answer.error));

  const handlers = {
    aril_switch: async (payload) => {
      if (!exactly(payload, [])) return INVALID;
      await held.ready;
      const { on, pairedOn } = held.state();
      return { ok: true, on, pairedOn };
    },
    aril_switch_set: async (payload, origin) => {
      if (!exactly(payload, ["on"]) || typeof payload.on !== "boolean") return INVALID;
      await held.ready;
      if (!desktop(origin) && !(origin?.paired && (!payload.on || held.state().pairedOn))) return DESKTOP_ONLY;
      const outcome = await held.set(payload.on);
      return outcome === "ok" ? { ok: true, on: held.isOn() } : outcome === "superseded" ? refused("conflict") : UNAVAILABLE;
    },
    aril_paired_on_set: async (payload, origin) => {
      if (!exactly(payload, ["allowed"]) || typeof payload.allowed !== "boolean") return INVALID;
      if (!desktop(origin)) return DESKTOP_ONLY;
      // The owner's choice ends the carry-over of the old per-repository permission, so it never undoes what the owner chose.
      void carry?.settle();
      const outcome = await held.setPairedOn(payload.allowed);
      return outcome === "ok" ? { ok: true, pairedOn: held.state().pairedOn } : outcome === "superseded" ? refused("conflict") : UNAVAILABLE;
    },
    owner_memory: async (payload) => (exactly(payload, []) ? { ok: true, memory: await memory.read() } : INVALID),
    owner_memory_set: async (payload, origin) => {
      if (!exactly(payload, ["text"])) return INVALID;
      if (!desktop(origin)) return DESKTOP_ONLY;
      return await isOff() ? WHILE_OFF : memoryAnswer(await memory.set(payload.text));
    },
    thread_space: async (payload, origin) => {
      if (!exactly(payload, [])) return INVALID;
      if (!desktop(origin)) return DESKTOP_ONLY;
      await limit.ready;
      return threads ? { ok: true, repositories: await threads.sizes(), limit: limit.megabytes() } : UNAVAILABLE;
    },
    thread_limit_set: async (payload, origin) => {
      if (!exactly(payload, ["megabytes"])) return INVALID;
      if (!desktop(origin)) return DESKTOP_ONLY;
      if (await isOff()) return WHILE_OFF;
      const outcome = await limit.set(payload.megabytes);
      return outcome === "ok" ? { ok: true, limit: limit.megabytes() } : outcome === "invalid" ? INVALID : UNAVAILABLE;
    },
    thread_flush: async (payload, origin) => {
      if (!exactly(payload, ["repositoryId"]) || !REPOSITORY_ID.test(String(payload.repositoryId))) return INVALID;
      if (!desktop(origin)) return DESKTOP_ONLY;
      if (await isOff()) return WHILE_OFF;
      return threads ? await threads.flush(payload.repositoryId) : UNAVAILABLE;
    },
  };

  return Object.freeze({
    /** Whether Aril is On now: the one question the grant runner, the grant write, and the automatic follow-ups ask before they act. */
    isOn: () => held.isOn(),
    /** Whether paired devices may turn Aril On and change a repository's memory and Aril's settings: the owner's one permission (`pairedOn`). */
    pairedAllowed,
    arilSwitch: held,
    pairedCarry: carry,
    ownerMemory: memory,
    threadLimit: limit,
    /** Whether a flush of the repository runs now. A message of the owner waits for it, so a flush never works on a conversation a turn is saving. */
    flushing: (repositoryId) => Boolean(threads?.flushing?.(repositoryId)),
    /**
     * Flushes the repository's thread by itself when it is over the owner's limit, nothing of the repository runs, and the limit is not
     * Never. The caller asks each time the repository becomes idle: a turn, a follow-up, or a compaction ended. It never throws.
     */
    async autoFlush(repositoryId) {
      try {
        await limit.ready;
        return threads ? await threads.autoFlush(repositoryId) : UNAVAILABLE;
      } catch { return UNAVAILABLE; }
    },
    /** The same for every repository with a thread: once after start. */
    async sweep() {
      try {
        await limit.ready;
        return threads ? await threads.sweep() : [];
      } catch { return []; }
    },
    handlers: Object.freeze(handlers),
  });
}
