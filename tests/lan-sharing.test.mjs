import assert from "node:assert/strict";
import test from "node:test";
import { createLanSharingController, installPhoneAccessIpc, PHONE_ACCESS_CHANNELS } from "../desktop/lan-sharing.mjs";
import { createDesktopSettingsStore, normalizeDesktopSettings } from "../desktop/settings.mjs";

const home = { id: "lan-home", address: "192.168.1.20", subnetMask: "255.255.255.0", label: "Wi-Fi" };
const other = { id: "lan-other", address: "192.168.2.20", subnetMask: "255.255.255.0", label: "Ethernet" };
function harness(overrides = {}) {
  let network = { status: "available", candidates: [home] };
  const handles = [];
  const timers = new Set();
  const saved = [];
  const changes = [];
  const controller = createLanSharingController({
    upstreamOrigin: "http://127.0.0.1:1234", authorizationToken: "private-launch-token",
    networkReader: { read: async () => network },
    schedule: (fn) => { timers.add(fn); return fn; }, cancel: (fn) => timers.delete(fn),
    canPersist: true, saveAutoStart: async (value) => saved.push(value),
    onChange: (value) => changes.push(value),
    startGateway: async (options) => {
      const handle = {
        options, origin: "http://192.168.1.20:5678", revoked: 0, closed: 0,
        revoke() { this.revoked++; }, async close() { this.closed++; },
        snapshot: () => ({ pairedClients: 1 }),
        createPairing: () => ({ url: "http://192.168.1.20:5678/__pomegr/pair#private-pairing", expiresAt: "2026-09-03T15:00:00.000Z" }),
        exit: new Promise(() => {}),
      };
      handles.push(handle);
      return handle;
    }, ...overrides,
  });
  return { controller, handles, timers, saved, changes, network: (value) => { network = value; } };
}

test("phone sharing starts only on opt-in and native state never contains private credentials", async () => {
  const h = harness();
  assert.equal((await h.controller.initialize()).status, "off");
  assert.equal(h.handles.length, 0);
  assert.equal((await h.controller.getState()).candidates.length, 1);
  const state = await h.controller.setSharing(true);
  assert.equal(state.status, "sharing");
  assert.equal(state.address, h.handles[0].origin);
  assert.equal(state.pairedClients, 1);
  assert.doesNotMatch(JSON.stringify(state), /subnetMask|authorization|private-launch|private-pairing/);
  assert.ok((await h.controller.createPairing()).url.includes("#private-pairing"));
  await h.controller.setSharing(false);
  assert.equal(h.controller.snapshot().address, null);
  assert.equal(await h.controller.createPairing(), null);
  assert.ok(h.handles[0].revoked > 0);
  assert.equal(h.handles[0].closed, 1);
  assert.equal(h.timers.size, 0);
  await h.controller.dispose();
});

test("ambiguous private networks require selection and unknown identifiers cannot bind", async () => {
  const h = harness();
  h.network({ status: "ambiguous", candidates: [home, other] });
  assert.equal((await h.controller.setSharing(true)).reason, "choose_network");
  assert.equal(h.handles.length, 0);
  await h.controller.setSharing(true, "invalid");
  assert.equal(h.handles.length, 0);
  assert.equal((await h.controller.setSharing(true, other.id)).selectedNetworkId, other.id);
  assert.equal(h.handles[0].options.host, other.address);
  await h.controller.dispose();
});

test("request validation and network watcher revoke clients on loss of the selected network", async () => {
  for (const viaRequest of [true, false]) {
    const h = harness();
    await h.controller.setSharing(true);
    h.network({ status: "unavailable", candidates: [] });
    if (viaRequest) assert.equal(await h.handles[0].options.isNetworkAllowed(), false);
    else await [...h.timers][0]();
    assert.equal(h.controller.snapshot().status, "unavailable");
    assert.equal(h.controller.snapshot().reason, "network_changed");
    assert.equal(h.controller.snapshot().address, null);
    assert.ok(h.handles[0].revoked > 0);
    await h.controller.dispose();
  }
});

test("sharing closes on an adapter, profile, or address change even within the same subnet", async () => {
  for (const replacement of [
    { ...home, id: "lan-new-interface" },
    { ...home, id: "lan-new-address", address: "192.168.1.21" },
    { ...home, id: "lan-new-mask", subnetMask: "255.255.0.0" },
  ]) {
    const h = harness();
    await h.controller.setSharing(true);
    h.network({ status: "available", candidates: [replacement] });
    assert.equal(await h.handles[0].options.isNetworkAllowed(), false);
    assert.deepEqual(h.controller.snapshot(), {
      status: "unavailable", reason: "network_changed", autoStart: false,
      candidates: [{ id: replacement.id, label: replacement.label, address: replacement.address }],
      selectedNetworkId: null, address: null, pairedClients: 0,
    });
    assert.ok(h.handles[0].revoked > 0);
    await h.controller.dispose();
  }
});

test("a pending startup cannot reopen sharing after stop or application disposal", async () => {
  for (const disposing of [false, true]) {
    let finish;
    let started;
    const beginning = new Promise((resolve) => { started = resolve; });
    const handle = { origin: "http://192.168.1.20:5678", revoked: 0, closed: 0, revoke() { this.revoked++; }, async close() { this.closed++; } };
    const h = harness({ startGateway: () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
    const pending = h.controller.setSharing(true);
    await beginning;
    const stop = disposing ? h.controller.dispose() : h.controller.setSharing(false);
    finish(handle);
    await Promise.all([pending, stop]);
    assert.equal(h.controller.snapshot().status, "off");
    assert.equal(handle.closed, 1);
    assert.ok(handle.revoked > 0);
    await h.controller.dispose();
  }
});

test("auto-start persists only a boolean and storage failure preserves the previous preference", async () => {
  const h = harness();
  await h.controller.setAutoStart(true);
  assert.deepEqual(h.saved, [true]);
  assert.equal(h.handles.length, 0);
  assert.equal((await h.controller.initialize()).status, "sharing");
  await h.controller.dispose();
  const failed = harness({ saveAutoStart: async () => { throw new Error("PRIVATE_STORAGE_ERROR"); } });
  assert.equal((await failed.controller.setAutoStart(true)).reason, "settings_unavailable");
  assert.equal(failed.controller.snapshot().autoStart, false);
  assert.doesNotMatch(JSON.stringify(failed.changes), /PRIVATE_STORAGE_ERROR/);
  await failed.controller.dispose();
});

test("an unavailable network or listener failure does not crash desktop initialization", async () => {
  const h = harness({ autoStart: true, startGateway: async () => { throw new Error("PRIVATE_NETWORK_ERROR"); } });
  assert.equal((await h.controller.initialize()).reason, "start_failed");
  h.network({ status: "unavailable", candidates: [] });
  assert.equal((await h.controller.setSharing(true)).reason, "network_unavailable");
  h.network({ status: "unavailable", candidates: [], reason: "public_network" });
  assert.equal((await h.controller.setSharing(true)).reason, "public_network");
  await h.controller.dispose();
});

test("phone native actions reject untrusted senders and invalid primitive inputs", async () => {
  const h = harness();
  const handlers = new Map();
  const trusted = {};
  const remove = installPhoneAccessIpc({
    ipcMain: { removeHandler: (name) => handlers.delete(name), handle: (name, fn) => handlers.set(name, fn) },
    isTrustedEvent: (event) => event === trusted, controller: h.controller,
  });
  assert.equal(await handlers.get(PHONE_ACCESS_CHANNELS.sharing)({}, true), null);
  assert.equal(await handlers.get(PHONE_ACCESS_CHANNELS.pair)({}), null);
  await handlers.get(PHONE_ACCESS_CHANNELS.sharing)(trusted, "true");
  await handlers.get(PHONE_ACCESS_CHANNELS.sharing)(trusted, true, { command: "unsafe" });
  assert.equal(h.handles.length, 0);
  await handlers.get(PHONE_ACCESS_CHANNELS.sharing)(trusted, true);
  assert.equal(h.handles.length, 1);
  remove();
  assert.equal(handlers.size, 0);
  await h.controller.dispose();
});

test("version-three migration cannot activate LAN sharing from an unknown legacy field", async () => {
  const legacy = { ...normalizeDesktopSettings(), version: 3, lanSharingAutoStart: true, pairingToken: "PRIVATE" };
  const store = createDesktopSettingsStore("C:\\Pomegr\\settings.json", { readFile: async () => JSON.stringify(legacy) });
  const loaded = await store.load();
  assert.equal(loaded.status, "migrated");
  assert.equal(loaded.settings.version, 4);
  assert.equal(loaded.settings.lanSharingAutoStart, false);
  assert.doesNotMatch(JSON.stringify(loaded), /PRIVATE|pairingToken/);
});
