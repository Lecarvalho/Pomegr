// The Jev key of the effort routing (agent-chat-jev.mjs): stored by desktop main, encrypted with the operating system's store through
// Electron's `safeStorage`, in one file under the desktop data root. The renderer can set it, remove it, and ask only whether it is set:
// no operation ever answers the key. It reaches no other process, file, log, prompt, or paired device. Where the operating system offers no
// encryption, nothing is stored and the option stays off; a key is never written as plain text.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const JEV_KEY_FILE = "jev-key-v1.bin";
export const AGENT_CHAT_JEV_CHANNEL = "pomegr:agent-chat-jev";
export const JEV_KEY_OPERATIONS = Object.freeze(["status", "set", "remove"]);
// One printable ASCII token: no space, no control character.
export const JEV_KEY_PATTERN = /^[!-~]{8,512}$/u;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const refused = (error) => Object.freeze({ ok: false, error });

/**
 * The key store. `safeStorage` is Electron's (`isEncryptionAvailable`, `encryptString`, `decryptString`) and `file` an absolute path.
 * `read()` answers the key or null and is for desktop main's routing only; `state()` answers `"set"`, `"unset"`, or `"unavailable"`;
 * `set(key)` and `remove()` answer `"ok"`, `"invalid"`, or `"unavailable"`. The key is kept in memory after the first read.
 */
export function createJevKey({ file, safeStorage, filesystem = { mkdir, readFile, rename, unlink, writeFile } }) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new TypeError("The Jev key needs an absolute file");
  // undefined: not read yet.
  let held;

  const encrypted = () => {
    try { return safeStorage?.isEncryptionAvailable?.() === true && safeStorage.getSelectedStorageBackend?.() !== "basic_text"; } catch { return false; }
  };

  async function read() {
    if (held !== undefined) return held;
    if (!encrypted()) return null;
    try {
      const key = safeStorage.decryptString(await filesystem.readFile(file));
      held = JEV_KEY_PATTERN.test(key) ? key : null;
    } catch (error) {
      // A missing file is no key. Any other failure leaves it unread, so the next send tries again.
      if (error?.code !== "ENOENT") return null;
      held = null;
    }
    return held;
  }

  return Object.freeze({
    read,
    async state() {
      if (!encrypted()) return "unavailable";
      return await read() ? "set" : "unset";
    },
    async set(key) {
      if (typeof key !== "string" || !JEV_KEY_PATTERN.test(key)) return "invalid";
      if (!encrypted()) return "unavailable";
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await filesystem.mkdir(path.dirname(file), { recursive: true });
        await filesystem.writeFile(temporary, safeStorage.encryptString(key), { mode: 0o600 });
        await filesystem.rename(temporary, file);
      } catch {
        await filesystem.unlink(temporary).catch(() => {});
        return "unavailable";
      }
      held = key;
      return "ok";
    },
    async remove() {
      try { await filesystem.unlink(file); } catch (error) { if (error?.code !== "ENOENT") return "unavailable"; }
      held = null;
      return "ok";
    },
  });
}

/**
 * The renderer's way to the key store, on a channel of its own that only the trusted window may use: `status`, `set` with `{ key }`, and
 * `remove`. An answer is `{ ok: true, state }` or `{ ok: false, error }` with `invalid` or `unavailable`, and never holds the key.
 * A paired device has no route to it. Answers with the remover.
 */
export function installJevKeyIpc({ ipcMain, isTrustedEvent, key }) {
  ipcMain.removeHandler(AGENT_CHAT_JEV_CHANNEL);
  ipcMain.handle(AGENT_CHAT_JEV_CHANNEL, async (event, operation, payload) => {
    try {
      if (!isTrustedEvent(event) || !JEV_KEY_OPERATIONS.includes(operation)) return refused("invalid");
      if (operation === "set") {
        if (!isPlainObject(payload) || Object.keys(payload).length !== 1) return refused("invalid");
        const outcome = await key.set(payload.key);
        if (outcome !== "ok") return refused(outcome);
      } else if (operation === "remove") {
        const outcome = await key.remove();
        if (outcome !== "ok") return refused(outcome);
      }
      return { ok: true, state: await key.state() };
    } catch { return refused("unavailable"); }
  });
  return () => ipcMain.removeHandler(AGENT_CHAT_JEV_CHANNEL);
}
