export type DesktopState = {
  applicationVersion?: string | null;
  paused: boolean;
  launchAtLogin: boolean;
  launchAtLoginAvailable: boolean;
  closeBehavior: "ask" | "tray" | "quit";
  notifications: boolean;
  notificationQuietUntil: string | null;
  displayPreferences: {
    contextHistory: boolean;
    estimatedCost: boolean;
  };
  update?: {
    status: "disabled" | "idle" | "checking" | "downloading" | "ready" | "installing" | "failed";
    version: string | null;
    lastCheckedAt?: string | null;
  };
};

export function DesktopControls({ state, onTogglePause, onSetLaunchAtLogin, onSetCloseBehavior, onSetNotifications, onSetNotificationQuiet, onQuit }: {
  state: DesktopState;
  onTogglePause: () => void;
  onSetLaunchAtLogin: (value: boolean) => void;
  onSetCloseBehavior: (value: DesktopState["closeBehavior"]) => void;
  onSetNotifications: (value: boolean) => void;
  onSetNotificationQuiet: (value: boolean) => void;
  onQuit: () => void;
}) {
  return (
    <details className="desktopControls">
      <summary>Desktop</summary>
      <div className="desktopControlsPanel" role="group" aria-label="Desktop controls">
        <button type="button" onClick={onTogglePause}>{state.paused ? "Resume live refresh" : "Pause live refresh"}</button>
        <label className="desktopToggle">
          <input type="checkbox" checked={state.launchAtLogin} disabled={!state.launchAtLoginAvailable} onChange={(event) => onSetLaunchAtLogin(event.currentTarget.checked)} />
          <span>Launch at login</span>
        </label>
        {!state.launchAtLoginAvailable && <small>Available in the installed app</small>}
        <label className="desktopToggle">
          <input type="checkbox" checked={state.notifications} onChange={(event) => onSetNotifications(event.currentTarget.checked)} />
          <span>Needs-input notifications</span>
        </label>
        <button type="button" disabled={!state.notifications} onClick={() => onSetNotificationQuiet(!state.notificationQuietUntil)}>
          {state.notificationQuietUntil ? "Resume notifications" : "Quiet notifications for 1 hour"}
        </button>
        <label className="desktopSelect">
          <span>When I close the window</span>
          <select value={state.closeBehavior} onChange={(event) => onSetCloseBehavior(event.currentTarget.value as DesktopState["closeBehavior"])}>
            <option value="ask">Ask me</option>
            <option value="tray">Keep running in tray</option>
            <option value="quit">Quit Pomegr</option>
          </select>
        </label>
        <a href="/settings?section=about">About Pomegr</a>
        <button className="desktopQuit" type="button" onClick={onQuit}>Quit Pomegr</button>
      </div>
    </details>
  );
}
