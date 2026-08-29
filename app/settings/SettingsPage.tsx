"use client";

import Link from "next/link";
import { NavigationMenuButton } from "../components/NavigationMenuButton";
import { PomegrBrand } from "../components/PomegrBrand";
import { ThemeToggle } from "../components/ThemeToggle";
import { DEFAULT_DISPLAY_PREFERENCES, useDisplayPreferences, type DisplayPreferences } from "../hooks/DisplayPreferencesContext";

function PreferenceRow({ id, label, description, checked, onChange }: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = `${id}-description`;
  return (
    <div className="displayPreferenceRow">
      <label htmlFor={id}>
        <strong>{label}</strong>
        <span id={descriptionId}>{description}</span>
      </label>
      <input id={id} type="checkbox" role="switch" checked={checked} aria-describedby={descriptionId} onChange={(event) => onChange(event.currentTarget.checked)} />
    </div>
  );
}

export function SettingsPage() {
  const { preferences, setPreference, resetPreferences } = useDisplayPreferences();
  const defaultsActive = (Object.keys(DEFAULT_DISPLAY_PREFERENCES) as Array<keyof DisplayPreferences>)
    .every((key) => preferences[key] === DEFAULT_DISPLAY_PREFERENCES[key]);

  return (
    <main className="settingsShell">
      <header className="topbar">
        <div className="topbarLead"><NavigationMenuButton /><PomegrBrand href="/" /></div>
        <div className="topActions"><ThemeToggle /><Link className="ghostButton settingsBack" href="/">Back to dashboard</Link></div>
      </header>
      <section className="settingsPage" aria-labelledby="settings-title">
        <div className="settingsIntro">
          <h1 id="settings-title">Settings</h1>
        </div>
        <section className="settingsPanel" aria-labelledby="session-display-title">
          <div className="settingsPanelHeader">
            <div>
              <h2 id="session-display-title">Session display</h2>
              <p>These preferences apply to every live and historical session.</p>
            </div>
            <button className="settingsReset" type="button" onClick={resetPreferences} disabled={defaultsActive}>Restore defaults</button>
          </div>
          <div className="displayPreferenceList">
            <PreferenceRow id="context-history-visible" label="Context history" description="Show the context-level timeline in live and historical sessions." checked={preferences.contextHistory} onChange={(checked) => setPreference("contextHistory", checked)} />
            <PreferenceRow id="estimated-cost-visible" label="API list-rate estimate" description="Show the provider-reported reference estimate when available. This is not a bill or subscription spend." checked={preferences.estimatedCost} onChange={(checked) => setPreference("estimatedCost", checked)} />
          </div>
        </section>
      </section>
    </main>
  );
}
