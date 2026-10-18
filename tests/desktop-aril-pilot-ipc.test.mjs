import assert from "node:assert/strict";
import test from "node:test";

import { ARIL_PILOT_CHANNEL, installArilPilotIpc } from "../desktop/runtime/aril-pilot-ipc.mjs";

const repositoryId = "repo-0123456789abcdef01234567";

test("pilot IPC accepts only trusted desktop operations and removes its background owner", async () => {
  const handlers = new Map();
  const calls = [];
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) };
  const pilot = Object.fromEntries(["read", "activate", "pause", "revoke"].map((operation) => [operation, async (payload) => {
    calls.push({ operation, payload }); return { ok: true, pilot: null };
  }]));
  pilot.start = () => calls.push("start");
  pilot.dispose = () => calls.push("dispose");
  const remove = installArilPilotIpc({ ipcMain, pilot, isTrustedEvent: (event) => event === "trusted" });
  const invoke = handlers.get(ARIL_PILOT_CHANNEL);
  assert.deepEqual(await invoke("LAN", "activate", { repositoryId }), { ok: false, error: "desktop_only" });
  for (const [operation, payload] of [["unknown", { repositoryId }], ["read", { repositoryId, goal: "foreign" }], ["pause", { repositoryId: "other" }]]) {
    assert.deepEqual(await invoke("trusted", operation, payload), { ok: false, error: "invalid" });
  }
  assert.deepEqual(calls, ["start"]);
  assert.equal((await invoke("trusted", "read", { repositoryId })).ok, true);
  assert.equal((await invoke("trusted", "activate", { repositoryId, goal: "Synthetic grant validated by coordinator" })).ok, true);
  assert.deepEqual(calls.slice(1), [{ operation: "read", payload: repositoryId }, { operation: "activate", payload: { repositoryId, goal: "Synthetic grant validated by coordinator" } }]);
  pilot.read = async () => { throw new Error("private error must not cross IPC"); };
  assert.deepEqual(await invoke("trusted", "read", { repositoryId }), { ok: false, error: "unavailable" });
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(calls.at(-1), "dispose");
});
