export type DesktopState = {
  paused: boolean;
  launchAtLogin: boolean;
  launchAtLoginAvailable: boolean;
  closeBehavior: "ask" | "tray" | "quit";
};

export function DesktopControls({ state, onTogglePause, onSetLaunchAtLogin, onSetCloseBehavior, onQuit }: {
  state: DesktopState;
  onTogglePause: () => void;
  onSetLaunchAtLogin: (value: boolean) => void;
  onSetCloseBehavior: (value: DesktopState["closeBehavior"]) => void;
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
        <label className="desktopSelect">
          <span>When I close the window</span>
          <select value={state.closeBehavior} onChange={(event) => onSetCloseBehavior(event.currentTarget.value as DesktopState["closeBehavior"])}>
            <option value="ask">Ask me</option>
            <option value="tray">Keep running in tray</option>
            <option value="quit">Quit Threadlight</option>
          </select>
        </label>
        <a href="/about">About Threadlight</a>
        <button className="desktopQuit" type="button" onClick={onQuit}>Quit Threadlight</button>
      </div>
    </details>
  );
}
