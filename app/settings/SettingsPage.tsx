"use client";

import { useRef, useState, type KeyboardEvent } from "react";
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
  const sections = [["appearance", "Appearance"], ["notifications", "Notifications"], ["data", "Data display"], ["about", "About"]] as const;
  type SectionId = typeof sections[number][0];
  const [section, setSection] = useState<SectionId>("appearance");
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const { preferences, setPreference, resetPreferences } = useDisplayPreferences();
  const defaultsActive = (Object.keys(DEFAULT_DISPLAY_PREFERENCES) as Array<keyof DisplayPreferences>)
    .every((key) => preferences[key] === DEFAULT_DISPLAY_PREFERENCES[key]);
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % sections.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + sections.length) % sections.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = sections.length - 1;
    else return;
    event.preventDefault();
    setSection(sections[nextIndex][0]);
    tabsRef.current[nextIndex]?.focus();
  };

  return (
    <section className="commandView commandSettings" aria-labelledby="settings-title">
      <header className="commandPageHeader"><div><h1 id="settings-title">Settings</h1><p>Local display and notification preferences. Monitoring remains read-only.</p></div><button className="commandSecondaryAction" type="button" onClick={resetPreferences} disabled={defaultsActive}>Restore defaults</button></header>
      <div className="commandSettingsLayout">
        <nav className="commandSettingsNav" aria-label="Settings sections" role="tablist">
          {sections.map(([id, label], index) => <button ref={(node) => { tabsRef.current[index] = node; }} id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`} tabIndex={section === id ? 0 : -1} key={id} type="button" role="tab" aria-selected={section === id} className={section === id ? "active" : ""} onClick={() => setSection(id)} onKeyDown={(event) => handleTabKey(event, index)}>{label}</button>)}
        </nav>
        {section === "appearance" && <section id="settings-panel-appearance" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-appearance"><h2>Workspace appearance</h2><p>These controls affect only this local Pomegr interface.</p><div className="commandSettingRow"><div><strong>Color theme</strong><span>Switch between the Command Center&apos;s dark and light operating surfaces.</span></div><ThemeToggle /></div><div className="commandSettingRow"><div><strong>Compact density</strong><span>A denser evidence layout will arrive in a future release.</span></div><span className="commandComingSoonLabel">Coming soon</span></div></section>}
        {section === "notifications" && <section id="settings-panel-notifications" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-notifications"><h2>Notification preferences</h2><p>Notification controls are available in the desktop runtime and will move here in a future release.</p><div className="commandSettingRow"><div><strong>Needs-input alerts</strong><span>Generic local notifications without prompt or response content.</span></div><span className="commandComingSoonLabel">Desktop managed</span></div><div className="commandSettingRow"><div><strong>Completed session updates</strong><span>Quiet completion notices are not available in the web interface yet.</span></div><span className="commandComingSoonLabel">Coming soon</span></div></section>}
        {section === "data" && <section id="settings-panel-data" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-data"><h2>Data display</h2><p>These preferences apply to every live and historical session.</p><div className="displayPreferenceList"><PreferenceRow id="context-history-visible" label="Context history" description="Show the context-level timeline in live and historical sessions." checked={preferences.contextHistory} onChange={(checked) => setPreference("contextHistory", checked)} /><PreferenceRow id="estimated-cost-visible" label="API list-rate estimate" description="Show the provider-reported reference estimate when available. This is not a bill or subscription spend." checked={preferences.estimatedCost} onChange={(checked) => setPreference("estimatedCost", checked)} /></div></section>}
        {section === "about" && <section id="settings-panel-about" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-about"><h2>About Pomegr</h2><p>A local-first, read-only observer for coding-agent sessions.</p><div className="commandSettingRow"><div><strong>Monitor boundary</strong><span>Normalized metadata is served from the loopback monitor. Conversation content remains private.</span></div><span className="commandReadyState">Read-only</span></div><div className="commandSettingRow"><div><strong>Application version</strong><span>Command Center shell</span></div><span className="commandMonoValue">v0.2.0</span></div></section>}
      </div>
    </section>
  );
}
