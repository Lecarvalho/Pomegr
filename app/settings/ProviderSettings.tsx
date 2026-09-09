"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ProviderFolderKey, ProviderSettingsBridge, ProviderSettingsResult, ProviderSettingsState } from "../../shared/provider-settings-contract";
import { PROVIDER_FOLDER_KEYS } from "../../shared/provider-settings-contract";

type ProviderFolderPaths = Record<ProviderFolderKey, string | null>;

class ProviderFolderAccessDenied extends Error {}

type FolderDefinition = {
  key: ProviderFolderKey;
  label: string;
  description: string;
};

const FOLDERS: FolderDefinition[] = [
  {
    key: "claudeConfigDir",
    label: "Configuration folder",
    description: "Session history, account usage, and provider setup follow this Claude Code profile.",
  },
  {
    key: "claudeProjectsDir",
    label: "Session folder override",
    description: "An advanced override for Claude Code sessions stored separately from the configuration folder.",
  },
  {
    key: "codexHome",
    label: "Home folder",
    description: "Session history, account usage, and provider setup follow this Codex home.",
  },
];

function nativeBridge() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pomegrDesktop?: ProviderSettingsBridge }).pomegrDesktop;
}

function desktopBridge() {
  const native = nativeBridge();
  if (native?.getProviderSettings) return native;
  return undefined;
}

function subscribeAvailability() { return () => {}; }
function providerSettingsAvailable() {
  return typeof window !== "undefined";
}
export function useProviderSettingsAvailable() {
  return useSyncExternalStore(subscribeAvailability, providerSettingsAvailable, () => false);
}

async function readSettings(): Promise<{ state: ProviderSettingsState | null; paths: ProviderFolderPaths | null }> {
  const bridge = desktopBridge();
  if (bridge) return { state: await bridge.getProviderSettings(), paths: null };
  const response = await fetch("/api/provider-folders", { cache: "no-store", credentials: "same-origin" });
  if ([401, 403, 404].includes(response.status)) throw new ProviderFolderAccessDenied();
  if (!response.ok) throw new Error("Provider folders unavailable");
  const payload = await response.json();
  const paths = payload?.folders;
  if (!paths || !PROVIDER_FOLDER_KEYS.every((key) => paths[key] === null
    || typeof paths[key] === "string" && paths[key].length > 0 && paths[key].length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(paths[key]))) {
    throw new Error("Provider folders unavailable");
  }
  return { state: null, paths: Object.fromEntries(PROVIDER_FOLDER_KEYS.map((key) => [key, paths[key]])) as ProviderFolderPaths };
}

function selectionLabel(selection: ProviderSettingsState["folders"][ProviderFolderKey]["selection"]) {
  switch (selection) {
    case "environment": return "Launch environment";
    case "custom": return "Custom folder";
    default: return "Default folder";
  }
}

function resultMessage(result: ProviderSettingsResult, action: "choose" | "reset" | "discard" | "save") {
  switch (result.status) {
    case "ready":
      return action === "choose" ? "Folder selection updated."
        : action === "reset" ? "Default folder selection restored."
          : action === "discard" ? "Uncommitted folder selections discarded."
            : "Session sources saved.";
    case "cancelled": return action === "save" ? "Changes were not applied." : "No folder was selected.";
    case "busy": return "Pomegr is already updating session sources. Wait for it to finish.";
    case "unavailable": return "Provider folder settings are unavailable in this desktop runtime.";
    case "restarting": return "Pomegr is restarting with the selected session sources.";
    default: return "Pomegr could not complete that change. Try again.";
  }
}

export function ProviderSettings() {
  const available = useProviderSettingsAvailable();
  const readOnly = !desktopBridge();
  const [state, setState] = useState<ProviderSettingsState | null>(null);
  const [paths, setPaths] = useState<ProviderFolderPaths | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<"choose" | "reset" | "discard" | "save" | null>(null);
  const [message, setMessage] = useState("");
  const [accessDenied, setAccessDenied] = useState(false);
  const requestId = useRef(0);
  const busy = busyAction !== null;

  async function retry() {
    if (!available) return;
    const id = ++requestId.current;
    setLoading(true);
    setMessage("");
    setAccessDenied(false);
    try {
      const next = await readSettings();
      if (id !== requestId.current) return;
      setState(next.state);
      setPaths(next.paths);
      if (!next.state && !next.paths) setMessage("Provider folders are unavailable. Try again.");
    } catch (error) {
      if (id === requestId.current) {
        setState(null);
        setPaths(null);
        setAccessDenied(error instanceof ProviderFolderAccessDenied);
        setMessage("Provider folders are unavailable. Try again.");
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!available) return;
    let active = true;
    const id = ++requestId.current;
    void readSettings().then((next) => {
      if (!active || id !== requestId.current) return;
      setState(next.state);
      setPaths(next.paths);
      setAccessDenied(false);
      if (!next.state && !next.paths) setMessage("Provider folders are unavailable. Try again.");
    }, (error: unknown) => {
      if (!active || id !== requestId.current) return;
      setState(null);
      setPaths(null);
      setAccessDenied(error instanceof ProviderFolderAccessDenied);
      setMessage("Provider folders are unavailable. Try again.");
    }).finally(() => {
      if (active && id === requestId.current) setLoading(false);
    });
    return () => { active = false; };
  }, [available]);

  async function run(action: "choose" | "reset" | "discard" | "save", key?: ProviderFolderKey) {
    const bridge = desktopBridge();
    if (!bridge || busy) return;
    const operation = action === "choose" ? () => bridge.chooseProviderFolder(key!)
      : action === "reset" ? () => bridge.resetProviderFolder(key!)
        : action === "discard" ? () => bridge.discardProviderSettings()
          : () => bridge.saveProviderSettings();
    const id = ++requestId.current;
    setBusyAction(action);
    setMessage("");
    try {
      const result = await operation();
      if (id !== requestId.current) return;
      if (result.state) setState(result.state);
      setMessage(resultMessage(result, action));
    } catch {
      if (id === requestId.current) setMessage("Pomegr could not complete that change. Try again.");
    } finally {
      if (id === requestId.current) setBusyAction(null);
    }
  }

  if (loading) return <p className="providerSettingsLoading" aria-live="polite">Loading provider folder settings…</p>;
  if (!state && !paths) return <section className="providerSettingsUnavailable" aria-labelledby="provider-settings-unavailable"><p id="provider-settings-unavailable" className="providerSettingsProblem" role="status">{accessDenied ? "Use paired LAN access to view provider folders." : message || "Provider folders are unavailable. Try again."}</p>{!accessDenied && <button className="commandSecondaryAction" type="button" onClick={() => void retry()}>Retry</button>}</section>;

  return <section className="providerSettings" aria-labelledby="provider-settings-heading">
    <header>
      <h2 id="provider-settings-heading">Providers</h2>
      <p>{readOnly ? "Local folders Pomegr uses for coding-agent sessions." : "Choose the local folders and profiles Pomegr uses for coding-agent sessions."}</p>
      {readOnly && <p className="providerSettingsGuidance">Folder paths are read-only in the browser. Open the desktop app to change them.</p>}
    </header>
    <section className="providerSettingsGroup" aria-labelledby="claude-provider-heading">
      <h3 id="claude-provider-heading">Claude Code</h3>
      <ProviderFolderRow folder={FOLDERS[0]} state={state} paths={paths} busy={busy} onChoose={() => void run("choose", "claudeConfigDir")} onReset={() => void run("reset", "claudeConfigDir")} />
      <details className="providerSettingsAdvanced"><summary>Advanced</summary><ProviderFolderRow folder={FOLDERS[1]} state={state} paths={paths} busy={busy} onChoose={() => void run("choose", "claudeProjectsDir")} onReset={() => void run("reset", "claudeProjectsDir")} /></details>
    </section>
    <section className="providerSettingsGroup" aria-labelledby="codex-provider-heading">
      <h3 id="codex-provider-heading">Codex</h3>
      <ProviderFolderRow folder={FOLDERS[2]} state={state} paths={paths} busy={busy} onChoose={() => void run("choose", "codexHome")} onReset={() => void run("reset", "codexHome")} />
    </section>
    <aside className="providerSettingsGuidance">Default uses the launch environment or standard folder. Pomegr does not move files, and the selected configuration drives Claude Code default session discovery. These settings do not control a running coding tool or its account.</aside>
    {state && <footer className="providerSettingsFooter">
      <button className="commandQuietAction" type="button" disabled={busy || !state.pendingChanges} onClick={() => void run("discard")}>Discard changes</button>
      <button className="commandPrimaryAction" type="button" disabled={busy || !state.canSave || !state.pendingChanges} onClick={() => void run("save")}>{busyAction === "save" ? "Saving…" : "Save and restart Pomegr"}</button>
    </footer>}
    {message && <p className="providerSettingsProblem" role="status">{message}</p>}
  </section>;
}

function ProviderFolderRow({ folder, state, paths, busy, onChoose, onReset }: {
  folder: FolderDefinition;
  state: ProviderSettingsState | null;
  paths: ProviderFolderPaths | null;
  busy: boolean;
  onChoose: () => void;
  onReset: () => void;
}) {
  const setting = state?.folders[folder.key];
  const availability = setting?.availability === "available" ? "Available" : "Unavailable";
  const fieldId = `provider-folder-${folder.key}`;
  const folderPath = paths?.[folder.key];
  const sessionFolder = paths && folder.key === "claudeProjectsDir";
  return <div className={`commandSettingRow providerSettingRow${paths ? " providerSettingPathRow" : ""}`}>
    <div><strong id={`${fieldId}-label`}>{sessionFolder ? "Session folder" : folder.label}</strong><span id={`${fieldId}-description`}>{sessionFolder ? "The effective folder Pomegr uses to discover Claude Code sessions." : folder.description}</span>{setting && <small>{selectionLabel(setting.selection)} · {availability}</small>}</div>
    <div className={paths ? "providerSettingControls" : undefined}>
    {paths && <input id={fieldId} className="providerSettingPath" type="text" readOnly value={folderPath ?? ""} placeholder="Path unavailable" title={folderPath ?? undefined} aria-labelledby={`${fieldId}-label`} aria-describedby={`${fieldId}-description`} spellCheck={false} />}
    {state && setting && <div className="providerSettingActions"><button className="commandSecondaryAction" type="button" disabled={busy || !state.canSave} onClick={onChoose}>Choose folder…</button><button className="commandQuietAction" type="button" disabled={busy || !state.canSave || setting.selection !== "custom"} onClick={onReset}>Use default</button></div>}
    </div>
  </div>;
}
