"use client";

import { useState } from "react";
import type { DesktopState } from "../components/DesktopControls";
import type { useDesktopUpdates } from "./DesktopUpdateSettings";
import { PreferenceRow, SettingRow } from "./SettingRow";

type BehaviorBridge = {
  setCloseBehavior?(value: DesktopState["closeBehavior"]): Promise<DesktopState | null>;
  setNotifications?(value: boolean): Promise<DesktopState | null>;
  setNotificationQuiet?(value: boolean): Promise<DesktopState | null>;
  setNotificationCategory?(key: "attention" | "provider_news" | "model_news", value: boolean): Promise<DesktopState | null>;
};
type Updates = ReturnType<typeof useDesktopUpdates>;

const CLOSE_CHOICES = [["ask", "Ask"], ["tray", "Keep in tray"], ["quit", "Quit"]] as const;
const FAILED = "Couldn’t save this setting. Try again.";

function behaviorBridge() {
  return typeof window === "undefined" ? undefined
    : (window as Window & { pomegrDesktop?: BehaviorBridge }).pomegrDesktop;
}

/** Runs one desktop mutation at a time and adopts the bounded snapshot it returns. */
function useBehaviorMutation(updates: Updates) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function mutate(action: (bridge: BehaviorBridge) => Promise<DesktopState | null> | undefined) {
    const bridge = behaviorBridge();
    if (!bridge || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = await action(bridge);
      if (next) updates.apply(next);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return { busy, failed, mutate };
}

function quietDescription(until: string | null) {
  const time = until ? new Date(until) : null;
  return time && Number.isFinite(time.getTime())
    ? `Alerts are paused until ${time.toLocaleTimeString(undefined, { timeStyle: "short" })}.`
    : "Pause alerts for one hour. This is not saved and ends when Pomegr restarts.";
}

export function DesktopNotificationSettings({ updates }: { updates: Updates }) {
  const { busy, failed, mutate } = useBehaviorMutation(updates);
  const state = updates.state;
  const alerts = state?.notifications === true;
  const categories = state?.notificationCategories;
  return <div data-testid="notification-preferences">
    <div className="displayPreferenceList">
      <PreferenceRow id="desktop-notifications" label="Desktop notifications" description="Show enabled categories as Windows notifications from this desktop app." checked={alerts} disabled={!state || busy} onChange={(checked) => void mutate((bridge) => bridge.setNotifications?.(checked))} />
      <PreferenceRow id="needs-input-quiet" label="Quiet for one hour" description={quietDescription(alerts ? state?.notificationQuietUntil ?? null : null)} checked={alerts && Boolean(state?.notificationQuietUntil)} disabled={!alerts || busy} onChange={(checked) => void mutate((bridge) => bridge.setNotificationQuiet?.(checked))} />
      <PreferenceRow id="notification-attention" label="Needs input" description="Alert when a live session starts waiting for your input." checked={categories?.attention !== false} disabled={!alerts || busy} onChange={(checked) => void mutate((bridge) => bridge.setNotificationCategory?.("attention", checked))} />
      <PreferenceRow id="notification-provider-news" label="Provider updates" description="Alert about supported provider release news. Off until you enable it." checked={categories?.provider_news === true} disabled={!alerts || busy} onChange={(checked) => void mutate((bridge) => bridge.setNotificationCategory?.("provider_news", checked))} />
      <PreferenceRow id="notification-model-news" label="Model news" description="Alert about supported model announcements. Off until you enable it." checked={categories?.model_news === true} disabled={!alerts || busy} onChange={(checked) => void mutate((bridge) => bridge.setNotificationCategory?.("model_news", checked))} />
    </div>
    {failed && <p className="commandUnavailableNote" role="status">{FAILED}</p>}
  </div>;
}

export function DesktopCloseSettings({ updates }: { updates: Updates }) {
  const { busy, failed, mutate } = useBehaviorMutation(updates);
  const state = updates.state;
  return <>
    <SettingRow label="When closing the window" description="Keep in tray continues observing in the background. Ask shows the choice each time until you remember one.">
      <div className="commandSegmented" role="group" aria-label="When closing the window">
        {CLOSE_CHOICES.map(([value, label]) => <button key={value} type="button" aria-pressed={state?.closeBehavior === value} disabled={!state || busy} onClick={() => void mutate((bridge) => bridge.setCloseBehavior?.(value))}>{label}</button>)}
      </div>
    </SettingRow>
    {failed && <p className="commandUnavailableNote" role="status">{FAILED}</p>}
  </>;
}
