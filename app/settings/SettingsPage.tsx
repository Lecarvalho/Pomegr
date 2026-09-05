"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PomegrMark } from "../components/PomegrBrand";
import { ThemeToggle } from "../components/ThemeToggle";
import { DEFAULT_DISPLAY_PREFERENCES, useDisplayPreferences, type DisplayPreferences } from "../hooks/DisplayPreferencesContext";
import { PhoneAccessControls, usePhoneAccessDesktopAvailable } from "../components/PhoneAccessControls";
import { DesktopUpdateSettings, useDesktopUpdates } from "./DesktopUpdateSettings";
import { AboutDetails } from "./AboutDetails";

function SettingRow({ label, description, children, className = "", labelFor, descriptionId }: {
  label: string;
  description: string;
  children: ReactNode;
  className?: string;
  labelFor?: string;
  descriptionId?: string;
}) {
  const copy = <><strong>{label}</strong><span id={descriptionId}>{description}</span></>;
  return (
    <div className={`commandSettingRow${className ? ` ${className}` : ""}`}>
      {labelFor ? <label htmlFor={labelFor}>{copy}</label> : <div>{copy}</div>}
      {children}
    </div>
  );
}

function PreferenceRow({ id, label, description, checked, onChange }: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = `${id}-description`;
  return (
    <SettingRow className="displayPreferenceRow" label={label} description={description} labelFor={id} descriptionId={descriptionId}>
      <input id={id} type="checkbox" role="switch" checked={checked} aria-describedby={descriptionId} onChange={(event) => onChange(event.currentTarget.checked)} />
    </SettingRow>
  );
}

export function SettingsPage({ initialSection = "appearance" }: { initialSection?: "appearance" | "about" }) {
  const updates = useDesktopUpdates();
  const phoneAccessAvailable = usePhoneAccessDesktopAvailable();
  const sections = phoneAccessAvailable
    ? [["appearance", "Appearance"], ["notifications", "Notifications"], ["phone", "Phone access"], ["data", "Data display"], ["about", "About"]] as const
    : [["appearance", "Appearance"], ["notifications", "Notifications"], ["data", "Data display"], ["about", "About"]] as const;
  type SectionId = typeof sections[number][0];
  const [section, setSection] = useState<SectionId>(initialSection);
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
          {sections.map(([id, label], index) => <button ref={(node) => { tabsRef.current[index] = node; }} id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`} tabIndex={section === id ? 0 : -1} key={id} type="button" role="tab" aria-selected={section === id} className={section === id ? "active" : ""} onClick={() => setSection(id)} onKeyDown={(event) => handleTabKey(event, index)}>{label}{id === "about" && updates.state?.update?.status === "ready" && <span className="commandUpdateDot" role="img" aria-label="Update ready to install" />}</button>)}
        </nav>
        {section === "appearance" && <section id="settings-panel-appearance" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-appearance"><h2>Workspace appearance</h2><p>These controls affect only this local Pomegr interface.</p><SettingRow label="Color theme" description="Switch between the Command Center's dark and light operating surfaces."><ThemeToggle /></SettingRow><SettingRow label="Compact density" description="A denser evidence layout will arrive in a future release."><span className="commandComingSoonLabel">Coming soon</span></SettingRow></section>}
        {section === "notifications" && <section id="settings-panel-notifications" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-notifications"><h2>Notification preferences</h2><p>Notification controls are available in the desktop runtime and will move here in a future release.</p><SettingRow label="Needs-input alerts" description="Generic local notifications without prompt or response content."><span className="commandComingSoonLabel">Desktop managed</span></SettingRow><SettingRow label="Completed session updates" description="Quiet completion notices are not available in the web interface yet."><span className="commandComingSoonLabel">Coming soon</span></SettingRow></section>}
        {section === "phone" && <section id="settings-panel-phone" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-phone"><PhoneAccessControls /></section>}
        {section === "data" && <section id="settings-panel-data" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-data"><h2>Data display</h2><p>These preferences apply to every live and historical session.</p><div className="displayPreferenceList"><PreferenceRow id="estimated-cost-visible" label="API list-rate estimate" description="Show the provider-reported reference estimate when available. This is not a bill or subscription spend." checked={preferences.estimatedCost} onChange={(checked) => setPreference("estimatedCost", checked)} /></div></section>}
        {section === "about" && <section id="settings-panel-about" className="commandSettingsPane" role="tabpanel" aria-labelledby="settings-tab-about"><div className="commandAboutIdentity"><PomegrMark className="commandAboutIdentityMark" /><div className="commandAboutIdentityText"><h2>About Pomegr</h2><p>A local-first, read-only observer for coding-agent sessions.</p></div></div>{updates.available && <><SettingRow label="Application version" description="Pomegr desktop"><span className="commandMonoValue">{updates.state?.applicationVersion ? `v${updates.state.applicationVersion}` : "Version unavailable"}</span></SettingRow><DesktopUpdateSettings updates={updates} /></>}<SettingRow label="Monitor boundary" description="Normalized metadata is served from the loopback monitor. Conversation content remains private."><span className="commandReadyState">Read-only</span></SettingRow><AboutDetails /></section>}
      </div>
    </section>
  );
}
