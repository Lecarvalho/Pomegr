"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DesktopState } from "../components/DesktopControls";

type UpdateBridge = {
  getDesktopState(): Promise<DesktopState | null>;
  checkForUpdates?(): Promise<DesktopState | null>;
  installUpdate?(): Promise<DesktopState | null>;
  onDesktopStateChanged(callback: (state: DesktopState) => void): () => void;
};

function desktopBridge() {
  return typeof window === "undefined" ? undefined
    : (window as Window & { pomegrDesktop?: UpdateBridge }).pomegrDesktop;
}

function subscribeAvailability() { return () => {}; }
function desktopAvailable() { return Boolean(desktopBridge()?.getDesktopState); }

export function useDesktopUpdates() {
  const available = useSyncExternalStore(subscribeAvailability, desktopAvailable, () => false);
  const [state, setState] = useState<DesktopState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const active = useRef(false);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!available || !bridge) return;
    active.current = true;
    const unsubscribe = bridge.onDesktopStateChanged((next) => {
      generation.current += 1;
      setState(next);
      setError("");
    });
    const initialGeneration = generation.current;
    void bridge.getDesktopState().then((next) => {
      if (active.current && generation.current === initialGeneration) {
        setState(next);
        if (!next) setError("Update status is unavailable. Try checking again.");
      }
    }, () => {
      if (active.current && generation.current === initialGeneration) setError("Update status is unavailable. Try checking again.");
    });
    return () => { active.current = false; generation.current += 1; unsubscribe(); };
  }, [available]);

  async function run(install: boolean) {
    const bridge = desktopBridge();
    const action = install ? bridge?.installUpdate : bridge?.checkForUpdates;
    if (!action || pending.current) return;
    pending.current = true;
    const actionGeneration = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await action.call(bridge);
      if (!active.current) return;
      if (generation.current === actionGeneration && next) setState(next);
      if (!next || (install && next.update?.status === "ready")) {
        setError(install ? "Couldn’t restart to install the update. Try again." : "Update status is unavailable. Try checking again.");
      }
    } catch {
      if (active.current) setError(install ? "Couldn’t restart to install the update. Try again." : "Couldn’t check for updates. Try again.");
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return { available, state, error, busy, run };
}

export function DesktopUpdateSettings({ updates }: { updates: ReturnType<typeof useDesktopUpdates> }) {
  const { state, error, busy, run } = updates;
  const update = state?.update;
  const status = update?.status;
  const ready = status === "ready";
  const lastChecked = update?.lastCheckedAt ? new Date(update.lastCheckedAt) : null;
  const checked = lastChecked !== null && Number.isFinite(lastChecked.getTime());
  const bridge = desktopBridge();
  const supported = Boolean(bridge?.checkForUpdates && bridge?.installUpdate);
  let message = "Loading update status…";
  let button = "Check for updates";
  if (status === "disabled") message = "Updates are unavailable in this app configuration.";
  else if (status === "checking") { message = "Checking for updates…"; button = "Checking…"; }
  else if (status === "downloading") { message = update?.version ? `Downloading v${update.version}…` : "Downloading update…"; button = "Downloading…"; }
  else if (ready) { message = `v${update?.version} is ready to install. Pomegr will restart.`; button = "Restart and install"; }
  else if (status === "installing") { message = "Restarting Pomegr to install the update…"; button = "Restarting…"; }
  else if (status === "failed") { message = "Couldn’t check for updates or finish the download."; button = "Try again"; }
  else if (status === "idle") message = checked ? "You’re up to date." : "Check for a newer version of Pomegr.";
  else if (state) message = "Update status is unavailable.";
  if (!supported) message = "Update controls are unavailable in this desktop runtime.";
  if (error && !ready) button = "Try again";
  const disabled = busy || !supported || status === "disabled" || status === "checking"
    || status === "downloading" || status === "installing" || (!state && !error);

  return (
    <div className="commandSettingRow commandUpdateRow">
      <div>
        <strong>Software updates</strong>
        <span id="desktop-update-status" role="status" aria-live="polite">{error || message}</span>
        {checked && <span>Last checked <time dateTime={update!.lastCheckedAt!}>{lastChecked.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></span>}
      </div>
      <button className={ready ? "commandPrimaryAction" : "commandSecondaryAction"} type="button" disabled={disabled} aria-describedby="desktop-update-status" onClick={() => { void run(ready); }}>
        {busy && status === "idle" ? "Checking…" : button}
      </button>
    </div>
  );
}
