"use client";

import QRCode from "qrcode";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PhoneAccessBridge, PhoneAccessState } from "../../shared/lan-sharing-contract";
import { CommandSelect } from "./command-center/CommandPage";

type PairingCode = { image: string; expiresAt: string; generation: number };
const unavailableState: PhoneAccessState = Object.freeze({ status: "unavailable", reason: "settings_unavailable", autoStart: false, candidates: [], selectedNetworkId: null, address: null, pairedClients: 0 });
let observedBridge: PhoneAccessBridge | undefined;
let observedState: PhoneAccessState | null = null;
let observedGeneration = 0;
let unsubscribeBridge: (() => void) | null = null;
const phoneAccessListeners = new Set<() => void>();

function desktopBridge() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pomegrDesktop?: PhoneAccessBridge }).pomegrDesktop;
}

function publishPhoneAccess(next: PhoneAccessState | null) {
  observedState = next || unavailableState;
  observedGeneration += 1;
  for (const listener of phoneAccessListeners) listener();
}

function connectPhoneAccessBridge() {
  const bridge = desktopBridge();
  if (!bridge || bridge === observedBridge) return;
  unsubscribeBridge?.();
  observedBridge = bridge;
  unsubscribeBridge = bridge.onPhoneAccessChanged((next) => publishPhoneAccess(next));
  void bridge.getPhoneAccessState().then(publishPhoneAccess, () => publishPhoneAccess(unavailableState));
}

function subscribePhoneAccess(listener: () => void) {
  phoneAccessListeners.add(listener);
  connectPhoneAccessBridge();
  return () => {
    phoneAccessListeners.delete(listener);
    if (phoneAccessListeners.size === 0) {
      unsubscribeBridge?.();
      unsubscribeBridge = null;
      observedBridge = undefined;
    }
  };
}

function phoneAccessSnapshot() { return observedState; }
function serverPhoneAccessSnapshot() { return null; }
function subscribeDesktopBridge() { return () => {}; }
export function phoneAccessDesktopAvailable() { return Boolean(desktopBridge()?.getPhoneAccessState); }
export function usePhoneAccessDesktopAvailable() { return useSyncExternalStore(subscribeDesktopBridge, phoneAccessDesktopAvailable, () => false); }

function unavailableMessage(state: PhoneAccessState) {
  switch (state.reason) {
    case "public_network": return "Windows classifies your connected network as Public.";
    case "network_unavailable": return "Pomegr could not find a private network to share on.";
    case "network_changed": return "Your private network changed. Choose it again before sharing.";
    case "start_failed": return "Pomegr could not start phone sharing. Check the selected private network and try again.";
    case "settings_unavailable": return "Phone access settings are unavailable in this desktop runtime.";
    default: return "Phone access is unavailable right now.";
  }
}

function unavailableGuidance(state: PhoneAccessState) {
  return state.reason === "public_network"
    ? "In Windows Settings, open Network & internet, select the connected Wi-Fi or Ethernet network, change Network profile type to Private, then refresh networks."
    : "Refresh networks or retry when the trusted private network is ready.";
}

function networkIsAmbiguous(state: PhoneAccessState) { return state.candidates.length > 1 || state.reason === "choose_network"; }

export function PhoneAccessControls() {
  const state = useSyncExternalStore(subscribePhoneAccess, phoneAccessSnapshot, serverPhoneAccessSnapshot);
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sharing" | "auto-start" | "pairing" | "refresh" | null>(null);
  const [message, setMessage] = useState("");
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!pairing) return;
    const remaining = new Date(pairing.expiresAt).getTime() - Date.now();
    const delay = Number.isFinite(remaining) ? Math.max(0, remaining + 20) : 0;
    const timer = window.setTimeout(() => setPairing(null), delay);
    return () => window.clearTimeout(timer);
  }, [pairing]);

  if (!state) return <p className="phoneAccessLoading" aria-live="polite">Loading phone access settings…</p>;
  const isSharing = state.status === "sharing";
  const unavailable = state.status === "unavailable";
  const selectedNetwork = [selectedNetworkId, state.selectedNetworkId]
    .find((id) => state.candidates.some((candidate) => candidate.id === id)) || "";
  const needsNetwork = networkIsAmbiguous(state);
  const shareDisabled = state.status === "starting" || busy !== null || (needsNetwork && !selectedNetwork);
  const rawAddress = state.address;
  const address = !rawAddress ? null : rawAddress.startsWith("http://") || rawAddress.startsWith("https://") ? rawAddress : `http://${rawAddress}`;
  const pairingVisible = pairing && isSharing && pairing.generation === observedGeneration;

  const changeSharing = async (enabled: boolean) => {
    const bridge = desktopBridge();
    if (!bridge || busy) return;
    const id = ++requestId.current;
    setBusy("sharing");
    setMessage("");
    if (!enabled) setPairing(null);
    try {
      const next = await bridge.setPhoneSharing(enabled, enabled ? selectedNetwork || undefined : undefined);
      if (id !== requestId.current || !next) throw new Error("Phone sharing unavailable");
      publishPhoneAccess(next);
      setSelectedNetworkId(next.selectedNetworkId);
    } catch {
      if (id === requestId.current) setMessage("Pomegr could not complete that change. Check the selected private network and try again.");
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  };

  const refreshNetworks = async () => {
    const bridge = desktopBridge();
    if (!bridge || busy) return;
    setBusy("refresh");
    setMessage("");
    try {
      const next = await bridge.getPhoneAccessState();
      if (!next) throw new Error("Phone access unavailable");
      publishPhoneAccess(next);
    } catch { setMessage("Pomegr could not refresh private networks. Try again."); }
    finally { setBusy(null); }
  };

  const changeAutoStart = async (enabled: boolean) => {
    const bridge = desktopBridge();
    if (!bridge || busy) return;
    const id = ++requestId.current;
    setBusy("auto-start");
    setMessage("");
    try {
      const next = await bridge.setPhoneAutoStart(enabled);
      if (id !== requestId.current || !next) throw new Error("Phone access unavailable");
      publishPhoneAccess(next);
    } catch {
      if (id === requestId.current) setMessage("Pomegr could not save that startup setting. Try again.");
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  };

  const createPairing = async () => {
    const bridge = desktopBridge();
    if (!bridge || busy || !isSharing) return;
    const id = ++requestId.current;
    const generation = observedGeneration;
    setBusy("pairing");
    setMessage("");
    try {
      const next = await bridge.createPhonePairing();
      if (id !== requestId.current || !next) throw new Error("Pairing unavailable");
      const image = await QRCode.toDataURL(next.url, { errorCorrectionLevel: "M", margin: 4, width: 224, color: { dark: "#000000", light: "#ffffff" } });
      if (id === requestId.current && generation === observedGeneration && phoneAccessSnapshot()?.status === "sharing") {
        setPairing({ image, expiresAt: next.expiresAt, generation });
      }
    } catch {
      if (id === requestId.current) setMessage("Pomegr could not create a pairing code. Try again.");
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  };

  return <section className="phoneAccessControls" aria-labelledby="phone-access-heading">
    <header><h2 id="phone-access-heading">Phone access</h2><p>Share this Pomegr view on a trusted private network.</p></header>
    {unavailable && <p className="phoneAccessProblem" role="status">{unavailableMessage(state)}</p>}
    {needsNetwork && <label className="phoneAccessNetwork"><span>Private network</span><CommandSelect aria-label="Private network" value={selectedNetwork} disabled={busy !== null || isSharing || state.status === "starting"} onChange={(event) => setSelectedNetworkId(event.currentTarget.value)}><option value="">Choose a private network</option>{state.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.label} · {candidate.address}</option>)}</CommandSelect></label>}
    <div className="phoneAccessAction"><div><strong>{isSharing ? "Sharing started" : state.status === "starting" || busy === "sharing" ? "Starting phone access" : unavailable ? "Phone access needs attention" : "Phone access is off"}</strong><span>{isSharing && address ? <>Open <a href={address}>{address}</a> on a paired phone.</> : unavailable ? unavailableGuidance(state) : "Phone sharing is off by default."}</span></div><div className="phoneAccessButtons">{unavailable && <button className="commandSecondaryAction" type="button" disabled={busy !== null} onClick={() => void refreshNetworks()}>{busy === "refresh" ? "Refreshing…" : "Refresh networks"}</button>}<button className={isSharing ? "commandSecondaryAction" : "commandPrimaryAction"} type="button" disabled={shareDisabled} onClick={() => void changeSharing(!isSharing)}>{busy === "sharing" ? (isSharing ? "Stopping…" : "Starting…") : isSharing ? "Stop sharing" : unavailable ? "Retry phone access" : "Enable phone access"}</button></div></div>
    {isSharing && <div className="phoneAccessPaired"><span><strong>{state.pairedClients}</strong> paired {state.pairedClients === 1 ? "phone" : "phones"}</span><button className="commandSecondaryAction" type="button" disabled={busy !== null} onClick={() => void createPairing()}>{busy === "pairing" ? "Creating code…" : pairingVisible ? "Regenerate code" : "Create pairing code"}</button></div>}
    {pairingVisible && <figure className="phoneAccessQr"><img src={pairing.image} alt="Scan this expiring code with your phone camera to pair this phone." width="224" height="224" /><figcaption>Pairing code expires at {new Date(pairing.expiresAt).toLocaleTimeString()}.</figcaption></figure>}
    <label className="phoneAccessAutoStart"><span><strong>Start on a private network</strong><small>Check for your private network each time Pomegr launches.</small></span><input type="checkbox" role="switch" checked={state.autoStart} disabled={busy !== null} onChange={(event) => void changeAutoStart(event.currentTarget.checked)} /></label>
    <aside className="phoneAccessGuidance"><strong>Before you share</strong><p>Phone access uses unencrypted HTTP on the selected trusted private network. Keep this PC awake and Pomegr running in its tray. Scan a new code after restarting sharing. Windows may ask to allow Pomegr on private networks; do not allow public-network access.</p></aside>
    {message && <p className="phoneAccessProblem" role="status">{message}</p>}
  </section>;
}
