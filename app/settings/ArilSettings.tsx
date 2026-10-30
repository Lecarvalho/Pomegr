"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ArilSettings as Settings, TaskBoard } from "../../shared/task-contract";
import { useArilSwitch, useOwnerMemory, useThreadSpace } from "../aril-control-client";
import { useRepositoryInventory } from "../repository-inventory-client";
import { useTasks } from "../tasks-store";
import { readStoredRepository, storeRepository } from "../components/agent-chat/agent-chat-presentation";
import { CommandSelect } from "../components/command-center/CommandSelect";
import { CommandSwitch } from "../components/command-center/CommandSwitch";
import { useJevKey } from "../components/tasks/jev-key-desktop";
import { sendTaskAction, useTaskEditAvailability, type GrantActionResult } from "../components/tasks/task-desktop";
import { timeOfDay } from "../components/tasks/task-schedule";
import { ArilCard, ArilMemoryCard, ArilOffNotice, ArilSwitchCard, ConversationSpaceCard, EffortRoutingRow, OwnerMemoryPane, repositoryMemoryCaption, type MemoryTab } from "./ArilGlobalSettings";
import { MemoryEditor } from "./MemoryEditor";
import { SettingRow } from "./SettingRow";

// The section keeps the controls of Aril itself (the switch, the memory, the conversation space, the effort routing) and, for one repository at a
// time, the settings that are not a grant's: who reviews and whether a paired device may change the repository's memory and settings. A grant's
// own sections (Grant, Actions under a grant, Limits, Work rules) are gone; phase 5 of the Aril plan replaces grants with agreements. Where a
// grant is still running, one line shows when it ends and offers Stop grant. The grant runtime itself is untouched.

const PROVIDERS = [{ value: "", label: "Any" }, { value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }];
const MODEL = /^(?![A-Za-z]:)[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]{0,119}$/;
const GRANT_REPOSITORIES = 16;
const FAILURES = { settings: "Aril settings could not be saved. Try again.", grant: "The grant could not be stopped. Try again." };
type Action = "aril_settings_set" | "aril_memory_set" | "grant_stop";
type Aril = NonNullable<TaskBoard["aril"]>;

const grantTime = (at: number) => timeOfDay(new Date(at).toISOString());

/** When an active grant ends, and Stop grant. Aril off means the grant does nothing, and the line says so. Nothing is drawn for a grant that is not active. */
export function GrantLine({ name, grant, arilOn, editable, busy = false, failed = false, onStop }: {
  name: string; grant: NonNullable<Aril["grant"]> | null | undefined; arilOn: boolean | null; editable: boolean; busy?: boolean; failed?: boolean; onStop(): void;
}) {
  if (!grant?.active) return null;
  return <div className="arilGrantLine">
    <span>{`A grant in ${name} is active until `}<span className="arilGrantTime">{grantTime(grant.endsAt)}</span>{arilOn === false ? ". Aril is off, so it does nothing." : "."}</span>
    {editable && <button type="button" className="commandSecondaryAction" aria-label={`Stop grant in ${name}`} disabled={busy} onClick={onStop}>Stop grant</button>}
    {failed && <span className="newTaskError" role="alert">{FAILURES.grant}</span>}
  </div>;
}

function RepositoryGrantLine({ repositoryId, name, arilOn }: { repositoryId: string; name: string; arilOn: boolean | null }) {
  const access = useTaskEditAvailability();
  const { board, refresh } = useTasks(repositoryId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const stop = async () => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try {
      const result = await sendTaskAction(repositoryId, "grant_stop", {});
      if (result.ok) await refresh(); else setFailed(true);
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <GrantLine name={name} grant={board.aril?.grant} arilOn={arilOn} editable={access === "desktop" || access === "paired"} busy={busy} failed={failed} onStop={() => void stop()} />;
}

/** The settings of one repository that a grant does not own, with one repository choice. Each control saves at once. */
export function ArilRepositoryCard({ aril, desktop, allowed, select, onAction, disabled = false, initialFailure = false }: {
  aril: Aril; desktop: boolean; allowed: boolean; select: ReactNode;
  /** The page's Aril-is-off state: every control is disabled and an edit that was open is closed. */
  disabled?: boolean;
  onAction(action: Action, payload: unknown): Promise<GrantActionResult>;
  initialFailure?: boolean;
}) {
  const settings = aril.settings;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(initialFailure);
  const [model, setModel] = useState<string | null>(null);
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) { setWasDisabled(disabled); if (disabled) setModel(null); }
  const shown = model ?? settings.reviewer.model ?? "";
  const modelValid = shown === "" || MODEL.test(shown);
  const save = async (change: Partial<Settings>) => {
    if (!allowed || busy || disabled) return;
    setBusy(true); setFailed(false);
    try {
      const result = await onAction("aril_settings_set", { settings: change });
      if (result.ok) setModel(null); else setFailed(true);
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  const reviewer = (part: Partial<Settings["reviewer"]>) => save({ reviewer: { ...settings.reviewer, ...part } });
  const commitModel = () => {
    if (model === null || !modelValid) return;
    if ((model.trim() || null) === settings.reviewer.model) { setModel(null); return; }
    void reviewer({ model: model.trim() || null });
  };
  const providerLabel = PROVIDERS.find((entry) => entry.value === (settings.reviewer.provider ?? ""))?.label ?? "Any";
  return <ArilCard title="Per repository" aside={select} className="arilRepositoryCard">
    <div className="arilRows" aria-busy={busy}>
      <SettingRow label="Reviewer" description="The provider and model for the reviews Aril starts. Any lets Aril choose.">
        {allowed ? <span className="arilReviewerControls">
          <CommandSelect aria-label="Reviewer provider" value={settings.reviewer.provider ?? ""} options={PROVIDERS} disabled={busy || disabled}
            onChange={(next) => void reviewer({ provider: (next || null) as Settings["reviewer"]["provider"] })} />
          <input className="taskOwnInput" aria-label="Reviewer model" placeholder="Any model" maxLength={120} spellCheck={false} value={shown} disabled={busy || disabled} aria-invalid={!modelValid}
            onChange={(event) => setModel(event.currentTarget.value)} onBlur={commitModel} onKeyDown={(event) => { if (event.key === "Enter") commitModel(); }} />
        </span> : <span className="arilReadOnly">{`${providerLabel} · ${settings.reviewer.model ?? "any model"}`}</span>}
      </SettingRow>
      {!modelValid && <p className="newTaskError arilRowNote">Use a model identifier of at most 120 characters, without spaces or paths.</p>}
      <SettingRow label="Different provider than the builder" description="With the reviewer provider on Any, review with the provider the builder did not use.">
        {allowed ? <CommandSwitch small aria-label="Use a different provider than the builder" checked={settings.reviewer.differentFromBuilder} disabled={busy || disabled} onChange={(next) => void reviewer({ differentFromBuilder: next })} />
          : <span className="arilReadOnly">{settings.reviewer.differentFromBuilder ? "On" : "Off"}</span>}
      </SettingRow>
      <SettingRow label="Paired devices" description="Let a paired device change this repository's memory and Aril settings. A paired device can always stop a grant.">
        {desktop ? <CommandSwitch small aria-label="Allow paired devices to change Aril settings and memory" checked={settings.pairedDevices} disabled={busy || disabled} onChange={(next) => void save({ pairedDevices: next })} />
          : <span className="arilReadOnly">{settings.pairedDevices ? "Allowed" : "Not allowed"}</span>}
      </SettingRow>
    </div>
    {failed && <p className="newTaskError arilCardAlert" role="alert">{FAILURES.settings}</p>}
  </ArilCard>;
}

/** One repository's memory: read from its board and saved through the fixed `aril_memory_set` action. */
function RepositoryMemoryPane({ repositoryId, name, now, disabled }: { repositoryId: string; name: string; now: number; disabled: boolean }) {
  const access = useTaskEditAvailability();
  const { board, refresh } = useTasks(repositoryId);
  if (access === "pending" || board.readiness === "loading") return <p className="arilCardNote" role="status">Reading memory…</p>;
  if (!board.aril) return <p className="arilCardNote">Memory is unavailable.</p>;
  const allowed = access === "desktop" || (access === "paired" && board.aril.settings.pairedDevices);
  const save = async (text: string) => {
    const result = await sendTaskAction(repositoryId, "aril_memory_set", { text });
    if (result.ok) await refresh();
    return result.ok;
  };
  return <MemoryEditor memory={board.aril.memory} editable={allowed} label={`${name} memory`} caption={repositoryMemoryCaption(name)} save={save} now={now} disabled={disabled} />;
}

/** The repository card of one repository, read from its board. A board that is not ready says so in a line. */
function RepositorySettings({ repositoryId, select, disabled }: { repositoryId: string; select: ReactNode; disabled: boolean }) {
  const access = useTaskEditAvailability();
  const { board, refresh } = useTasks(repositoryId);
  if (access === "pending" || board.readiness === "loading") return <p className="arilCardNote" role="status">Reading Aril settings…</p>;
  if (!board.aril) return <p className="arilCardNote">Aril settings are unavailable.</p>;
  const desktop = access === "desktop";
  return <ArilRepositoryCard aril={board.aril} desktop={desktop} allowed={desktop || (access === "paired" && board.aril.settings.pairedDevices)} select={select} disabled={disabled}
    onAction={async (action, payload) => {
      const result = await sendTaskAction(repositoryId, action as "aril_settings_set", payload);
      if (result.ok) await refresh();
      return result;
    }} />;
}

/**
 * The Aril section of Settings. The top card holds the switch. Under it come the memory (yours, then each repository's), the space each
 * conversation takes, and, in the desktop app, the effort routing. The last card holds the settings of one repository that a grant does not own,
 * with a repository choice like the chat's: the repository the page was opened for, else the last one used, else the first listed. Memory opens
 * at the repository the link names, else at yours.
 */
export function ArilSettingsSection({ initialRepositoryId = null }: { initialRepositoryId?: string | null }) {
  const headingId = useId();
  const { snapshot, loading } = useRepositoryInventory();
  const access = useTaskEditAvailability();
  const jev = useJevKey(access === "desktop");
  const aril = useArilSwitch();
  const ownerMemory = useOwnerMemory();
  const space = useThreadSpace();
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  // The footer of a memory counts from this moment; it is read again each minute and never while the page is drawn on a server.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const options = useMemo(() => snapshot.repositories.map((repository) => ({ value: repository.id, label: repository.displayName })), [snapshot.repositories]);
  const names = useMemo(() => new Map(options.map((option) => [option.value, option.label])), [options]);
  const known = (id: string | null) => id !== null && options.some((option) => option.value === id);
  const repositoryId = [picked, initialRepositoryId, readStoredRepository()].find(known) ?? options[0]?.value ?? null;
  const choose = (id: string) => { storeRepository(id); setPicked(id); };
  const hasOwner = ownerMemory.availability === "desktop" || ownerMemory.availability === "paired" || ownerMemory.availability === "pending";
  const tabs: MemoryTab[] = [...(hasOwner ? [{ id: "owner", label: "You" }] : []), ...options.map((option) => ({ id: option.value, label: option.label }))];
  const activeTab = [tab, known(initialRepositoryId) ? initialRepositoryId : null, hasOwner ? "owner" : null, options[0]?.value ?? null].find((id) => id !== null && tabs.some((entry) => entry.id === id)) ?? null;
  // While Aril is off, everything under the switch card is read only and gray. Until the switch is answered it reads the same, so the page never
  // shows the cards editable and then takes that back; a plain browser has no switch and edits nothing anyway.
  const reachable = aril.availability !== "absent";
  const locked = reachable && aril.state?.on !== true;
  const select = options.length > 1 ? <CommandSelect aria-label="Repository" value={repositoryId ?? ""} options={options} disabled={locked} onChange={choose} /> : options[0] ? <span className="commandMonoValue">{options[0].label}</span> : null;
  return <section className="arilSettings" aria-labelledby={headingId}>
    <ArilSwitchCard control={aril} headingId={headingId} />
    {options.slice(0, GRANT_REPOSITORIES).map((option) => <RepositoryGrantLine key={option.value} repositoryId={option.value} name={option.label} arilOn={aril.state?.on ?? null} />)}
    {aril.state?.on === false && <ArilOffNotice />}
    <div className={`arilBelow${locked ? " isLocked" : ""}`} aria-disabled={locked || undefined}>
      {activeTab !== null && <ArilMemoryCard tabs={tabs} tab={activeTab} onTab={setTab} disabled={locked}>
        {activeTab === "owner" ? <OwnerMemoryPane control={ownerMemory} now={now} disabled={locked} />
          : <RepositoryMemoryPane key={activeTab} repositoryId={activeTab} name={names.get(activeTab) ?? ""} now={now} disabled={locked} />}
      </ArilMemoryCard>}
      <ConversationSpaceCard control={space} names={names} disabled={locked} />
      {jev && <EffortRoutingRow jev={jev} disabled={locked} />}
      {repositoryId === null
        ? <p className="arilCardNote">{loading ? "Reading repositories…" : "No repositories observed yet."}</p>
        : <RepositorySettings key={repositoryId} repositoryId={repositoryId} select={select} disabled={locked} />}
    </div>
  </section>;
}
