import { startLanGateway } from "./lan-gateway.mjs";
import { createLanNetworkReader } from "./lan-network.mjs";

export const PHONE_ACCESS_CHANNELS = Object.freeze({
  get: "pomegr:phone-access-state",
  sharing: "pomegr:set-phone-sharing",
  autoStart: "pomegr:set-phone-auto-start",
  pair: "pomegr:create-phone-pairing",
  changed: "pomegr:phone-access-changed",
});

function sameNetworkIdentity(left, right) {
  return typeof left?.id === "string" && left.id === right?.id
    && typeof left?.address === "string" && left.address === right?.address
    && typeof left?.subnetMask === "string" && left.subnetMask === right?.subnetMask;
}

/** Optional desktop transport. It owns no provider work or observation state. */
export function createLanSharingController(options = {}) {
  const reader = options.networkReader || createLanNetworkReader();
  const startGateway = options.startGateway || startLanGateway;
  const schedule = options.schedule || ((callback) => { const timer = setTimeout(callback, 5000); timer.unref?.(); return timer; });
  const cancel = options.cancel || clearTimeout;
  let autoStart = options.autoStart === true;
  let status = "off";
  let reason = null;
  let candidates = [];
  let selected = null;
  let gateway = null;
  let timer = null;
  let generation = 0;
  let disposed = false;
  let queue = Promise.resolve();
  let disposing;

  const snapshot = () => Object.freeze({
    status, reason, autoStart,
    candidates: candidates.map(({ id, label, address }) => ({ id, label, address })),
    selectedNetworkId: selected?.id || null,
    address: gateway?.origin || null,
    pairedClients: Math.max(0, Math.min(4, gateway?.snapshot().pairedClients || 0)),
  });
  const broadcast = () => { try { options.onChange?.(snapshot()); } catch { /* UI lifetime is independent. */ } };
  const enqueue = (operation) => { const result = queue.catch(() => {}).then(operation); queue = result; return result; };
  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const networkRead = async (force = false) => {
    try { return await reader.read({ force }); } catch { return { status: "unavailable", candidates: [] }; }
  };
  const replaceCandidates = (network) => { candidates = network.status === "unavailable" ? [] : network.candidates.slice(0, 8); };

  async function closeGateway(handle) {
    if (!handle) return;
    try { handle.revoke(); } catch { /* All sockets still get a close attempt. */ }
    try { await handle.close(); } catch { /* Gateway failures never stop the desktop. */ }
  }

  async function invalidate(handle, failure = "network_changed") {
    if (!handle || gateway !== handle) return;
    generation += 1;
    clearTimer();
    gateway = null;
    selected = null;
    status = "unavailable";
    reason = failure;
    handle.revoke();
    broadcast();
    await closeGateway(handle);
  }

  function watchNetwork(handle, network) {
    clearTimer();
    timer = schedule(async () => {
      timer = null;
      if (disposed || gateway !== handle) return;
      const current = await networkRead(true);
      if (disposed || gateway !== handle) return;
      replaceCandidates(current);
      if (!current.candidates.some((entry) => sameNetworkIdentity(entry, network))) await invalidate(handle);
      else watchNetwork(handle, network);
    });
  }

  async function getState() {
    if (disposed) return snapshot();
    const revision = generation;
    const network = await networkRead();
    if (revision !== generation || disposed) return snapshot();
    replaceCandidates(network);
    if (gateway && !network.candidates.some((entry) => sameNetworkIdentity(entry, selected))) await invalidate(gateway);
    return snapshot();
  }

  function setSharing(enabled, networkId) {
    if (disposed || typeof enabled !== "boolean" || (networkId !== undefined && (typeof networkId !== "string" || networkId.length > 80))) return Promise.resolve(snapshot());
    const revision = ++generation;
    clearTimer();
    // Revocation happens immediately, even while a previous start is settling.
    if (!enabled) gateway?.revoke();
    return enqueue(async () => {
      if (disposed || revision !== generation) return snapshot();
      const previous = gateway;
      gateway = null;
      selected = null;
      await closeGateway(previous);
      if (disposed || revision !== generation) return snapshot();
      if (!enabled) { status = "off"; reason = null; broadcast(); return snapshot(); }
      status = "starting";
      reason = null;
      broadcast();
      const network = await networkRead(true);
      if (disposed || revision !== generation) return snapshot();
      replaceCandidates(network);
      const chosen = networkId ? candidates.find((entry) => entry.id === networkId) : candidates.length === 1 ? candidates[0] : null;
      if (!chosen) {
        status = "unavailable";
        reason = candidates.length > 1 ? "choose_network"
          : network.reason === "public_network" ? "public_network" : "network_unavailable";
        broadcast();
        return snapshot();
      }
      let handle;
      const isNetworkAllowed = async () => {
        if (disposed || revision !== generation) return false;
        const latest = await networkRead();
        const allowed = !disposed && revision === generation && latest.candidates.some((entry) => sameNetworkIdentity(entry, chosen));
        if (!allowed) replaceCandidates(latest);
        if (!allowed && handle) void invalidate(handle);
        return allowed;
      };
      try {
        handle = await startGateway({
          host: chosen.address, subnetMask: chosen.subnetMask,
          upstreamOrigin: options.upstreamOrigin, authorizationToken: options.authorizationToken,
          isNetworkAllowed, onChange: broadcast,
        });
        if (disposed || revision !== generation) { await closeGateway(handle); return snapshot(); }
        gateway = handle;
        selected = chosen;
        status = "sharing";
        reason = null;
        void handle.exit?.then(() => { if (gateway === handle && !disposed) void invalidate(handle, "start_failed"); });
        watchNetwork(handle, chosen);
      } catch {
        if (handle) await closeGateway(handle);
        if (disposed || revision !== generation) return snapshot();
        gateway = null;
        selected = null;
        status = "unavailable";
        reason = "start_failed";
      }
      broadcast();
      return snapshot();
    });
  }

  function setAutoStart(enabled) {
    if (disposed || typeof enabled !== "boolean") return Promise.resolve(snapshot());
    return enqueue(async () => {
      if (disposed) return snapshot();
      if (options.canPersist !== true) { reason = "settings_unavailable"; broadcast(); return snapshot(); }
      try {
        await options.saveAutoStart(enabled);
        autoStart = enabled;
        if (reason === "settings_unavailable") reason = null;
      } catch { reason = "settings_unavailable"; }
      broadcast();
      return snapshot();
    });
  }

  return Object.freeze({
    snapshot, getState, setSharing, setAutoStart,
    initialize: () => autoStart && !disposed ? setSharing(true) : Promise.resolve(snapshot()),
    async createPairing() {
      await getState();
      if (disposed || status !== "sharing" || !gateway) return null;
      try { return gateway.createPairing(); } catch { return null; }
    },
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      generation += 1;
      clearTimer();
      const previous = gateway;
      gateway = null;
      selected = null;
      status = "off";
      reason = null;
      previous?.revoke();
      disposing = Promise.allSettled([closeGateway(previous), queue]).then(() => undefined);
      return disposing;
    },
  });
}

export function installPhoneAccessIpc({ ipcMain, isTrustedEvent, controller }) {
  const channels = PHONE_ACCESS_CHANNELS;
  const handlers = new Map([
    [channels.get, () => controller.getState()],
    [channels.sharing, (_event, enabled, networkId) => controller.setSharing(enabled, networkId)],
    [channels.autoStart, (_event, enabled) => controller.setAutoStart(enabled)],
    [channels.pair, () => controller.createPairing()],
  ]);
  for (const [channel, handler] of handlers) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedEvent(event)) return null;
      try { return await handler(event, ...args); } catch { return null; }
    });
  }
  return () => { for (const channel of handlers.keys()) ipcMain.removeHandler(channel); };
}
