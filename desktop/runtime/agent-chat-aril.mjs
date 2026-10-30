// Aril's own controls, held by desktop main beside the chat: the One On/Off switch, the owner's memory, and the space each thread takes
// on disk with its flush. The chat's `handle` serves these operations to the desktop window and, for the few a paired device may use, to a
// paired device through the LAN gateway. Aril itself reaches none of them: no provider run, tool, queue, or monitor path turns the
// switch On or changes a memory.
//
// Who may do what:
// - The switch: anyone may read it. The desktop window turns it On or Off. A paired device may always turn it Off (a stop is always
//   allowed, as a grant's is), and may turn it On only when the owner allowed that on the desktop (`aril_paired_on_set`).
// - The owner's memory: anyone may read it; only the desktop window changes it.
// - The thread space and the flush: the desktop window only.

import path from "node:path";

import { createArilSwitch, ARIL_DIRECTORY, ARIL_SWITCH_FILE } from "./aril-switch.mjs";
import { createOwnerMemory, OWNER_MEMORY_FILE } from "./aril-owner-memory.mjs";
import { AGENT_CHAT_DIRECTORY } from "./agent-chat-store.mjs";
import { createThreadSpace } from "./agent-chat-space.mjs";

export const ARIL_CONTROL_OPERATIONS = Object.freeze(["aril_switch", "aril_switch_set", "aril_paired_on_set", "owner_memory", "owner_memory_add", "owner_memory_update", "owner_memory_remove", "thread_space", "thread_flush"]);

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const refused = (error) => Object.freeze({ ok: false, error });
const INVALID = refused("invalid");
const UNAVAILABLE = refused("unavailable");
const DESKTOP_ONLY = refused("desktop_only");
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactly = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/**
 * `dataRoot` holds the switch and the owner's memory (`<dataRoot>/aril-v1/`) and the threads (`<dataRoot>/agent-chat-v1/`). Tests give
 * `arilSwitch`, `ownerMemory`, and `space` of their own. `busy(repositoryId)` says whether a turn of the repository runs or waits, and
 * `onOff()` is called each time the switch turns Off, to drop what Off must not run.
 */
export function createArilControl({ dataRoot = null, arilSwitch, ownerMemory, space, store, images, busy = () => false, onOff = () => {}, now } = {}) {
  const held = arilSwitch ?? createArilSwitch(dataRoot ? { file: path.join(dataRoot, ARIL_DIRECTORY, ARIL_SWITCH_FILE) } : {});
  const memory = ownerMemory ?? createOwnerMemory({ ...(dataRoot ? { file: path.join(dataRoot, ARIL_DIRECTORY, OWNER_MEMORY_FILE) } : {}), ...(now ? { now: () => now().getTime() } : {}) });
  const threads = space ?? (dataRoot && store ? createThreadSpace({ directory: path.join(dataRoot, AGENT_CHAT_DIRECTORY), store, images, busy }) : null);
  held.subscribe((state) => { if (!state.on) onOff(); });

  const desktop = (origin) => Boolean(origin?.event);
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
      const outcome = await held.setPairedOn(payload.allowed);
      return outcome === "ok" ? { ok: true, pairedOn: held.state().pairedOn } : outcome === "superseded" ? refused("conflict") : UNAVAILABLE;
    },
    owner_memory: async (payload) => (exactly(payload, []) ? { ok: true, entries: await memory.read() } : INVALID),
    owner_memory_add: async (payload, origin) => {
      if (!exactly(payload, ["text"])) return INVALID;
      return desktop(origin) ? memoryAnswer(await memory.add(payload.text)) : DESKTOP_ONLY;
    },
    owner_memory_update: async (payload, origin) => {
      if (!exactly(payload, ["id", "text"])) return INVALID;
      return desktop(origin) ? memoryAnswer(await memory.update(payload.id, payload.text)) : DESKTOP_ONLY;
    },
    owner_memory_remove: async (payload, origin) => {
      if (!exactly(payload, ["id"])) return INVALID;
      return desktop(origin) ? memoryAnswer(await memory.remove(payload.id)) : DESKTOP_ONLY;
    },
    thread_space: async (payload, origin) => {
      if (!exactly(payload, [])) return INVALID;
      if (!desktop(origin)) return DESKTOP_ONLY;
      return threads ? { ok: true, repositories: await threads.sizes() } : UNAVAILABLE;
    },
    thread_flush: async (payload, origin) => {
      if (!exactly(payload, ["repositoryId"]) || !REPOSITORY_ID.test(String(payload.repositoryId))) return INVALID;
      if (!desktop(origin)) return DESKTOP_ONLY;
      return threads ? await threads.flush(payload.repositoryId) : UNAVAILABLE;
    },
  };

  return Object.freeze({
    /** Whether Aril is On now: the one question the grant runner, the grant write, and the automatic follow-ups ask before they act. */
    isOn: () => held.isOn(),
    arilSwitch: held,
    ownerMemory: memory,
    handlers: Object.freeze(handlers),
  });
}
