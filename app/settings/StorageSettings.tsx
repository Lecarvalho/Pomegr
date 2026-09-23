"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import type {
  StorageMaxMbSetting,
  StorageRetentionDaySetting,
  StorageSettingsBridge,
  StorageSettingsResult,
  StorageSettingsState,
} from "../../shared/storage-settings-contract";
import { STORAGE_MAX_MB_SETTINGS, STORAGE_RETENTION_DAY_SETTINGS } from "../../shared/storage-settings-contract";
import type { StorageCleanupStatus, StorageSnapshot } from "../../shared/storage-contract";
import { CommandSelect } from "../components/command-center/CommandPage";
import { relativeTime } from "../dashboard-utils";

const RETENTION_LABELS: Record<StorageRetentionDaySetting, string> = {
  30: "30 days",
  90: "90 days",
  180: "180 days",
  365: "365 days",
  0: "Keep all",
};

const READINESS_VALUES = new Set(["loading", "rebuilding", "ready", "unavailable"]);
const CLEANUP_STATUS_VALUES = new Set(["normal", "cleanup_pending", "protected_excess"]);
const RETENTION_DAY_VALUES = new Set([30, 90, 180, 365]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function nativeBridge() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pomegrDesktop?: StorageSettingsBridge }).pomegrDesktop;
}

function desktopBridge() {
  const native = nativeBridge();
  if (native?.getStorageSettings) return native;
  return undefined;
}

function subscribeAvailability() { return () => {}; }
function storageBridgeAvailable() {
  return Boolean(desktopBridge());
}
/**
 * SSR-safe: the server render and the first client paint both report no bridge (matching),
 * so the desktop draft only takes over once React has settled past hydration. This mirrors
 * the other desktop-bridge gates in this file's siblings (Providers, Phone access), but the
 * Storage nav entry itself stays unconditional (D1), so only the draft/read-only state here
 * needs the gate.
 */
function useStorageDesktopBridge() {
  return useSyncExternalStore(subscribeAvailability, storageBridgeAvailable, () => false);
}

/** Rejects anything that does not match `shared/storage-contract.ts` field by field. */
function validateSnapshot(body: unknown): StorageSnapshot | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (typeof value.revision !== "number") return null;
  if (typeof value.readiness !== "string" || !READINESS_VALUES.has(value.readiness)) return null;
  if (value.databaseBytes !== null && typeof value.databaseBytes !== "number") return null;
  if (typeof value.thresholdBytes !== "number") return null;
  if (value.percent !== null && typeof value.percent !== "number") return null;
  if (value.oldestRetainedDay !== null && (typeof value.oldestRetainedDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.oldestRetainedDay))) return null;
  if (value.lastPrunedAt !== null && typeof value.lastPrunedAt !== "string") return null;
  if (value.retentionDays !== null && (typeof value.retentionDays !== "number" || !RETENTION_DAY_VALUES.has(value.retentionDays))) return null;
  if (value.cleanupStatus !== null && (typeof value.cleanupStatus !== "string" || !CLEANUP_STATUS_VALUES.has(value.cleanupStatus))) return null;
  return {
    revision: value.revision as number,
    readiness: value.readiness as StorageSnapshot["readiness"],
    databaseBytes: value.databaseBytes as number | null,
    thresholdBytes: value.thresholdBytes as number,
    percent: value.percent as number | null,
    oldestRetainedDay: value.oldestRetainedDay as string | null,
    lastPrunedAt: value.lastPrunedAt as string | null,
    retentionDays: value.retentionDays as StorageSnapshot["retentionDays"],
    cleanupStatus: value.cleanupStatus as StorageSnapshot["cleanupStatus"],
  };
}

async function fetchSnapshot(): Promise<StorageSnapshot | null> {
  try {
    const response = await fetch("/api/storage", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return null;
    return validateSnapshot(await response.json());
  } catch {
    return null;
  }
}

/**
 * 1024-base: under 10 MB keeps one decimal, under 1024 MB rounds to whole MB, and at or above
 * 1024 MB switches to GB with one decimal, dropping a trailing `.0` (so 1024 MB -> `1 GB`).
 */
export function formatStorageBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = (mb / 1024).toFixed(1);
  return `${gb.endsWith(".0") ? gb.slice(0, -2) : gb} GB`;
}

function usageAvailable(snapshot: StorageSnapshot | null): snapshot is StorageSnapshot & { databaseBytes: number; percent: number } {
  if (!snapshot) return false;
  if (snapshot.readiness === "loading" || snapshot.readiness === "unavailable") return false;
  return snapshot.databaseBytes !== null && snapshot.percent !== null;
}

/** `<used> / <threshold> · <pct>%`, or the honest unavailable text — never a fabricated 0%. */
export function storageUsageText(snapshot: StorageSnapshot | null): string {
  if (!usageAvailable(snapshot)) return "Storage usage unavailable";
  return `${formatStorageBytes(snapshot.databaseBytes)} / ${formatStorageBytes(snapshot.thresholdBytes)} · ${snapshot.percent}%`;
}

/** Clamps a (possibly over-100) percent to the 0-100 range the meter fill may occupy. */
export function storageMeterFill(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

export function cleanupStatusText(status: StorageCleanupStatus | null): string {
  if (status === "cleanup_pending") return "Cleanup pending";
  if (status === "protected_excess") return "Preserved history exceeds the cleanup threshold.";
  return "";
}

function formatOldestDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${date} ${MONTHS[month - 1]} ${year}`;
}

export function storageStatusLine(snapshot: StorageSnapshot | null, now: number = Date.now()): string {
  if (!snapshot || snapshot.readiness === "unavailable") return "Unavailable";
  if (snapshot.readiness === "rebuilding") return "Rebuilding";
  if (snapshot.readiness === "loading" || snapshot.databaseBytes === null) return "Unavailable";
  const size = formatStorageBytes(snapshot.databaseBytes);
  const oldest = snapshot.oldestRetainedDay ? `oldest retained ${formatOldestDay(snapshot.oldestRetainedDay)}` : "no retained curves";
  const pruned = snapshot.lastPrunedAt ? `last prune ${relativeTime(snapshot.lastPrunedAt, now)}` : "not pruned yet";
  return `${size} · ${oldest} · ${pruned}`;
}

const USAGE_BAR_COPY = "At 100%, older resource curves and detailed sample windows become eligible for automatic cleanup. File history and recorded peaks are preserved. Age retention applies independently: data older than the retention age is removed whatever the store size.";

/** Shared informational meter, also rendered at /design-system. Never focusable, never a slider. */
export function StorageUsageBar({ snapshot }: { snapshot: StorageSnapshot | null }) {
  const available = usageAvailable(snapshot);
  const text = storageUsageText(snapshot);
  const fill = usageAvailable(snapshot) ? storageMeterFill(snapshot.percent) : 0;
  const cleanupText = cleanupStatusText(snapshot?.cleanupStatus ?? null);
  return (
    <div className="storageUsageBar">
      <p className="storageUsageText">{text}</p>
      <div
        className="storageUsageTrack"
        role={available ? "meter" : undefined}
        aria-valuemin={available ? 0 : undefined}
        aria-valuemax={available ? 100 : undefined}
        aria-valuenow={available ? fill : undefined}
        aria-valuetext={available ? text : undefined}
      >
        {available && <b style={{ width: `${fill}%` }} />}
      </div>
      <p className="storageUsageCopy">{USAGE_BAR_COPY}</p>
      {cleanupText && <p className="storageUsageCleanupStatus" role="status">{cleanupText}</p>}
    </div>
  );
}

function resultMessage(result: StorageSettingsResult): string {
  switch (result.status) {
    case "cancelled": return "Changes were not applied.";
    case "busy": return "Pomegr is already updating storage settings. Wait for it to finish.";
    case "unavailable": return "Storage settings are unavailable in this desktop runtime.";
    case "restarting": return "Pomegr is restarting with the new storage settings.";
    case "failed": return "Pomegr could not complete that change. Try again.";
    default: return "";
  }
}

function mbFromThresholdBytes(thresholdBytes: number): StorageMaxMbSetting {
  const mb = Math.round(thresholdBytes / (1024 * 1024));
  return (STORAGE_MAX_MB_SETTINGS as readonly number[]).includes(mb) ? (mb as StorageMaxMbSetting) : 500;
}

type StorageAction = "retention" | "threshold" | "discard" | "save";

export function StorageSettings() {
  const hasBridge = useStorageDesktopBridge();
  const readOnly = !hasBridge;
  const [snapshot, setSnapshot] = useState<StorageSnapshot | null>(null);
  const [settingsState, setSettingsState] = useState<StorageSettingsState | null>(null);
  const [busyAction, setBusyAction] = useState<StorageAction | null>(null);
  const [message, setMessage] = useState("");
  const requestId = useRef(0);
  const busy = busyAction !== null;

  useEffect(() => {
    let active = true;
    async function load() {
      const next = await fetchSnapshot();
      if (active) setSnapshot(next);
    }
    void load();
    const interval = setInterval(() => void load(), 30_000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  useEffect(() => {
    // No bridge yet (SSR/pre-hydration, or a genuine browser/LAN client): leave the draft at
    // its initial null, which the read-only fallbacks below already treat as "use the snapshot".
    const bridge = desktopBridge();
    if (!bridge) return;
    let active = true;
    bridge.getStorageSettings().then((state) => { if (active) setSettingsState(state); }, () => { if (active) setSettingsState(null); });
    return () => { active = false; };
  }, [hasBridge]);

  async function run(action: StorageAction, operation: (bridge: StorageSettingsBridge) => Promise<StorageSettingsResult>) {
    const bridge = desktopBridge();
    if (!bridge || busy) return;
    const id = ++requestId.current;
    setBusyAction(action);
    setMessage("");
    try {
      const outcome = await operation(bridge);
      if (id !== requestId.current) return;
      setSettingsState(outcome.state);
      setMessage(resultMessage(outcome));
    } catch {
      if (id === requestId.current) setMessage("Pomegr could not complete that change. Try again.");
    } finally {
      if (id === requestId.current) setBusyAction(null);
    }
  }

  const controlsDisabled = readOnly || busy || !settingsState;
  const currentRetention: StorageRetentionDaySetting | null = !readOnly && settingsState
    ? settingsState.values.retentionDays
    : snapshot
      ? (snapshot.retentionDays === null ? 0 : snapshot.retentionDays)
      : null;
  const currentThresholdMb: StorageMaxMbSetting | null = !readOnly && settingsState
    ? settingsState.values.storeMaxMb
    : snapshot
      ? mbFromThresholdBytes(snapshot.thresholdBytes)
      : null;

  function handleRetention(option: StorageRetentionDaySetting) {
    if (controlsDisabled) return;
    void run("retention", (bridge) => bridge.setStorageSetting("retentionDays", option));
  }
  function handleThreshold(event: ChangeEvent<HTMLSelectElement>) {
    if (controlsDisabled) return;
    const value = Number(event.currentTarget.value) as StorageMaxMbSetting;
    void run("threshold", (bridge) => bridge.setStorageSetting("storeMaxMb", value));
  }

  return (
    <section className="storageSettings" aria-labelledby="storage-settings-heading">
      <header>
        <h2 id="storage-settings-heading">Storage</h2>
        <p>How long Pomegr keeps resource curves and how large its local store may grow. Peaks and file history stay for as long as a session remains in the catalog.</p>
        {readOnly && <p className="providerSettingsGuidance">Storage settings are read-only in the browser. Open the desktop app to change them.</p>}
      </header>
      <div className="storageSettingsPanel">
        <div className="commandSettingRow">
          <div><strong>Retention age</strong><span>Resource curves and peak windows older than this are removed. The peaks table is kept.</span></div>
          <div className="commandSegmented" role="group" aria-label="Retention age">
            {STORAGE_RETENTION_DAY_SETTINGS.map((option) => (
              <button key={option} type="button" aria-pressed={currentRetention === option} disabled={controlsDisabled} onClick={() => handleRetention(option)}>
                {RETENTION_LABELS[option]}
              </button>
            ))}
          </div>
        </div>
        <div className="commandSettingRow">
          <div><strong>Resource history cleanup threshold</strong><span>Older resource curves and detailed sample windows become eligible for cleanup above this size.</span></div>
          <CommandSelect aria-label="Resource history cleanup threshold" value={currentThresholdMb ?? ""} disabled={controlsDisabled} onChange={handleThreshold}>
            {STORAGE_MAX_MB_SETTINGS.map((mb) => <option key={mb} value={mb}>{formatStorageBytes(mb * 1024 * 1024)}</option>)}
          </CommandSelect>
        </div>
        <div className="commandSettingRow storageUsageRow">
          <StorageUsageBar snapshot={snapshot} />
        </div>
        <div className="commandSettingRow">
          <div><strong>Storage status</strong><span>Read from the monitor. Never shows file locations.</span></div>
          <span className="storageStatusValue">{storageStatusLine(snapshot)}</span>
        </div>
        <p className="storageSettingsFootnote">Sessions past the retention age show their peaks table and a note that the resource curve was not retained.</p>
      </div>
      <aside className="providerSettingsGuidance">Retention is editable only in the desktop app and takes effect on the next prune cycle. Browser and paired phone views are read-only here. Pruning never removes sessions, transcripts, or checkpoints.</aside>
      {!readOnly && <footer className="providerSettingsFooter">
        <button className="commandQuietAction" type="button" disabled={busy || !settingsState?.pendingChanges} onClick={() => void run("discard", (bridge) => bridge.discardStorageSettings())}>Discard changes</button>
        <button className="commandPrimaryAction" type="button" disabled={busy || !settingsState?.canSave || !settingsState?.pendingChanges} onClick={() => void run("save", (bridge) => bridge.saveStorageSettings())}>{busyAction === "save" ? "Saving…" : "Save and restart Pomegr"}</button>
      </footer>}
      {!readOnly && message && <p className="providerSettingsProblem" role="status">{message}</p>}
    </section>
  );
}
