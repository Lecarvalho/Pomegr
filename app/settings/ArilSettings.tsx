"use client";

import { useId, useMemo, useState } from "react";
import type { ArilSettings as Settings, TaskBoard } from "../../shared/task-contract";
import { useArilSwitch, useOwnerMemory, useThreadSpace } from "../aril-control-client";
import { useRepositoryInventory } from "../repository-inventory-client";
import { useTasks } from "../tasks-store";
import { readStoredRepository, storeRepository } from "../components/agent-chat/agent-chat-presentation";
import { CommandSelect } from "../components/command-center/CommandSelect";
import { JEV_KEY_PATTERN, useJevKey, type JevKeyControl } from "../components/tasks/jev-key-desktop";
import { sendTaskAction, useTaskEditAvailability, type GrantActionResult } from "../components/tasks/task-desktop";
import { timeOfDay } from "../components/tasks/task-schedule";
import { ArilSwitchPanel, OwnerMemorySection, ThreadSpaceSection } from "./ArilGlobalSettings";
import { MemoryList } from "./MemoryList";
import { SettingRow } from "./SettingRow";

const ACTIONS = { start: "Start tasks", review: "Start reviews", sendBack: "Send work back", merge: "Merge on green", writeTasks: "Write tasks from plans",
  markDone: "Mark done when acceptance passes" };
const LIMITS = { hours: ["Hours", 1, 72], tasks: ["Tasks", 1, 100], tasksAtATime: ["Tasks at a time", 1, 10], sendBacks: ["Send-backs per task", 0, 10], usagePercent: ["Usage limit %", 1, 100] } as const;
const KINDS = { tag: "Tag", text: "Text", feature: "Feature", tasks: "Tasks", plan: "Plan" };
const UNSET = "Not settled: Aril will ask";
const METHODS = [{ value: "", label: "Repository default" }, { value: "squash", label: "Squash" }, { value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase" }];
const MODES = [{ value: "", label: "Not set" }, { value: "direct", label: "Merge when green" }, { value: "auto", label: "Auto-merge when green" }];
const BRANCHES = [{ value: "", label: "Repository default" }, { value: "delete", label: "Delete" }, { value: "keep", label: "Keep" }];
const MODEL = /^(?![A-Za-z]:)[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]{0,119}$/;
const PLAN_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/;
const line = (value: string, max: number) => value.trim().length > 0 && value.length <= max && !/[\p{Cc}\u2028\u2029]/u.test(value);
const validPlanPath = (value: string) => line(value, 200) && PLAN_PATH.test(value) && !value.split("/").some((part) => part === "." || part === "..");
const END_REASONS = { stopped: "you stopped it", expired: "its time ran out", tasks_used: "it used all its tasks", start_failed: "a start failed", app_restart: "the app restarted" };
const FAILURES = { settings: "Aril settings could not be saved. Try again.", memory: "Memory could not be saved. Try again.",
  not_ready: "The grant is not ready. Check the saved limits, actions, and work rules.", conflict: "A grant is already active. Refresh the board.", grant: "The grant could not be changed. Try again." };
const grantTime = (at: number) => timeOfDay(new Date(at).toISOString());
type Action = "aril_settings_set" | "aril_memory_add" | "aril_memory_update" | "aril_memory_remove" | "grant_start" | "grant_stop";
type Props = {
  board: TaskBoard & { aril: NonNullable<TaskBoard["aril"]> }; desktop: boolean; editable: boolean;
  onAction(action: Action, payload: unknown): Promise<GrantActionResult>;
  /** The Jev key of the effort routing: given only in the desktop app, so a paired device neither sets nor sees it. */
  jev?: JevKeyControl;
  /** Whether Aril is On, or null/undefined while that is not known. A grant starts nothing while Aril is Off. */
  arilOn?: boolean | null;
};

/** The settings of one repository's Aril: the same content in the live Settings section and the static design-system frames. */
export function ArilSettings({ board, desktop, editable, onAction, jev, arilOn = null, initialFailure = null, initialConfirm = false }: Props & {
  initialFailure?: "settings" | "memory" | null; initialConfirm?: boolean | number;
}) {
  const allowed = editable && (desktop || board.aril.settings.pairedDevices);
  // The board is read again after every action, so the saved settings can change under a draft: a field the owner has not touched follows
  // the saved value, and a field the owner changed keeps the owner's value, so a save never writes an older value over a newer one.
  const savedKey = JSON.stringify(board.aril.settings);
  const [base, setBase] = useState({ key: savedKey, settings: board.aril.settings });
  const [edited, setDraft] = useState(base.settings);
  if (savedKey !== base.key) {
    const next = board.aril.settings;
    setDraft((current) => Object.fromEntries((Object.keys(next) as (keyof Settings)[]).map((key) => [key, JSON.stringify(current[key]) === JSON.stringify(base.settings[key]) ? next[key] : current[key]])) as Settings);
    setBase({ key: savedKey, settings: next });
  }
  const original = base.settings;
  const draft = allowed ? edited : board.aril.settings;
  const [kind, setKind] = useState<keyof typeof KINDS>("tag");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<keyof typeof FAILURES | null>(initialFailure);
  const [jevKey, setJevKey] = useState("");
  const [jevBusy, setJevBusy] = useState(false);
  const [jevFailed, setJevFailed] = useState<"save" | "remove" | null>(null);
  const saved = board.aril.settings;
  const grant = board.aril.grant;
  const confirmation = () => ({ settings: JSON.stringify(saved), until: Date.now() + saved.limits.hours! * 3600000 });
  // A static frame passes the end time it shows, so rendering it never reads the clock: a render on the server and the hydration after it must agree.
  const [confirm, setConfirm] = useState<ReturnType<typeof confirmation> | null>(() => initialConfirm ? { ...confirmation(), ...(typeof initialConfirm === "number" ? { until: initialConfirm } : {}) } : null);
  const change = <K extends keyof Settings>(key: K, next: Settings[K]) => { setConfirm(null); setDraft({ ...draft, [key]: next }); };
  const changed = Object.fromEntries((Object.keys(draft) as (keyof Settings)[])
    .filter((key) => (desktop || key !== "pairedDevices") && JSON.stringify(draft[key]) !== JSON.stringify(original[key]))
    .map((key) => [key, draft[key]]));
  const unsaved = allowed && Object.keys(changed).length > 0;
  const notReady = saved.actions.sendBack && saved.limits.sendBacks === null ? "Set Send-backs per task first."
    : [saved.limits.hours, saved.limits.tasks, saved.limits.tasksAtATime, saved.limits.usagePercent].includes(null) ? "Set Hours, Tasks, Tasks at a time, and Usage limit % first."
    : saved.actions.merge && saved.mergeMode === null ? "Choose how a grant merges first."
    : saved.actions.writeTasks && !saved.workRules.some((rule) => rule.kind === "plan") ? "Add a plan rule first: a grant writes tasks only from named plans."
      : saved.actions.writeTasks && !saved.actions.start ? "Allow starting tasks to use Write tasks from plans."
        : !saved.actions.start && !saved.actions.review && !saved.actions.merge ? "Allow starting tasks, reviews, or merges first."
      : saved.workRules.length === 0 ? "Add a work rule first: a grant starts nothing without one." : null;
  const confirming = confirm && !unsaved && !notReady && confirm.settings === JSON.stringify(saved);
  const model = draft.reviewer.model?.trim() ?? "";
  const modelValid = draft.reviewer.model === null || draft.reviewer.model === "" || MODEL.test(model);
  const ids = value.split(",").map((id) => id.trim());
  const ruleValid = kind === "feature" ? board.features.some((feature) => feature.id === value)
    : kind === "tasks" ? ids.length <= 50 && ids.every((id) => board.tasks.some((task) => task.id === id))
      : kind === "tag" ? line(value, 40) && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u.test(value) && value.toLowerCase() !== "image"
        : kind === "plan" ? validPlanPath(value) : line(value, 80);
  const memory = board.aril.memory;
  const send = async (action: Action, payload: unknown, done: () => void) => {
    if (!(action === "grant_stop" ? editable : allowed) || busy) return;
    if (action === "grant_start" && (unsaved || notReady || !confirming)) return;
    const grantAction = action === "grant_start" || action === "grant_stop";
    const errorKind = grantAction ? "grant" : action === "aril_settings_set" ? "settings" : "memory";
    setBusy(true); setFailure(null);
    try {
      const result = await onAction(action, payload);
      if (result.ok) done(); else setFailure(grantAction && (result.error === "not_ready" || result.error === "conflict") ? result.error : errorKind);
    } catch { setFailure(errorKind); }
    finally { setBusy(false); }
  };
  // A memory change reports whether the desktop accepted it, so the list keeps what was typed when it did not.
  const memoryAction = async (action: Action, payload: unknown) => {
    let accepted = false;
    await send(action, payload, () => { accepted = true; });
    return accepted;
  };
  // The key is sent once and the field is emptied when it was saved: the renderer never receives the key back, only whether one is set.
  const changeJev = async (which: "save" | "remove") => {
    if (!jev || jevBusy) return;
    const key = jevKey;
    setJevBusy(true); setJevFailed(null);
    try {
      if (await (which === "save" ? jev.save(key) : jev.remove())) setJevKey(""); else setJevFailed(which);
    } catch { setJevFailed(which); }
    finally { setJevBusy(false); }
  };
  const toggle = (label: string, checked: boolean, onChange: (next: boolean) => void) => allowed
    ? <label className="taskCheckRow"><input type="checkbox" role="switch" checked={checked} disabled={busy} onChange={(event) => onChange(event.currentTarget.checked)} /><span>{label}</span></label>
    : <div className="taskGateRow"><span>{label}</span><span className="taskGateReadOnly">{checked ? "On" : "Off"}</span></div>;
  const choice = (label: string, options: typeof METHODS, value: string, onChange: (next: string) => void) => <div className="taskGateField taskGateThreshold"><span className="taskGateFieldLabel">{label}</span>
    {allowed ? <CommandSelect aria-label={label} disabled={busy} value={value} options={options} onChange={onChange} />
      : <span className="taskGateReadOnly">{options.find((option) => option.value === value)?.label}</span>}
  </div>;
  return <div className="taskQueueSettings arilSettingsBody" aria-busy={busy} style={{ overflowWrap: "anywhere" }}>
    <section className="taskGatesPanel">
      <h3 className="taskGatesHeading">Grant</h3>
      {grant?.active ? <>
        <p className="taskGatesCaption">Active until <span className="taskCapacityValue">{grantTime(grant.endsAt)}</span> · <span className="taskCapacityValue">{grant.startsUsed}</span> of <span className="taskCapacityValue">{grant.limits.tasks}</span> tasks used</p>
        {editable && <button type="button" className="commandSecondaryAction" disabled={busy} onClick={() => void send("grant_stop", {}, () => setConfirm(null))}>Stop grant</button>}
        <p className="taskGatesCaption">Stopping takes effect at once. Running sessions continue.</p>
        {arilOn === false && <p className="taskGatesCaption">Aril is off, so this grant does nothing until you turn it on above.</p>}
      </> : <>
        {notReady ? <p className="taskGatesCaption">{notReady}</p> : <p className="taskGatesCaption">Starts {saved.actions.start ? saved.actions.review ? "tasks and reviews" : "tasks" : "reviews"} that your work rules select, for {saved.limits.hours} hours, at most {saved.limits.tasks} tasks, {saved.limits.tasksAtATime} at a time.</p>}
        {unsaved && <p className="taskGatesCaption">Save your changes first.</p>}
        {arilOn === false && <p className="taskGatesCaption">Aril is off. A grant does nothing until you turn it on above.</p>}
        {allowed && !notReady && <>
          {confirming && <p className="taskGatesCaption">Aril will start sessions without asking until {grantTime(confirm.until)} or until you stop it.</p>}
          <div className="taskHeadActions"><button type="button" className="commandPrimaryAction" disabled={busy || unsaved || arilOn === false}
            onClick={() => confirming ? void send("grant_start", {}, () => setConfirm(null)) : setConfirm(confirmation())}>Start grant</button>
            {confirming && <button type="button" className="commandQuietAction" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>}</div>
        </>}
        {grant && <p className="taskGatesCaption">Last grant ended {grantTime(grant.endedAt)}: {END_REASONS[grant.endReason]}</p>}
      </>}
      {failure && ["grant", "not_ready", "conflict"].includes(failure) && <p className="newTaskError" role="alert">{FAILURES[failure]}</p>}
    </section>
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Actions under a grant</h3>
      <p className="taskGatesCaption">Aril uses these only while a grant you start is active.</p>
      {(Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).map((key) => <div key={key}>{toggle(ACTIONS[key], draft.actions[key], (next) => change("actions", { ...draft.actions, [key]: next }))}</div>)}
      {choice("Merge method", METHODS, draft.mergeMethod ?? "", (next) => change("mergeMethod", next as Settings["mergeMethod"] || null))}
      {choice("Merge mode", MODES, draft.mergeMode ?? "", (next) => change("mergeMode", next as Settings["mergeMode"] || null))}
      {choice("Delete branch after merge", BRANCHES, draft.deleteBranch === null ? "" : draft.deleteBranch ? "delete" : "keep", (next) => change("deleteBranch", next === "" ? null : next === "delete"))}
      {toggle("Send follow-ups", draft.followUps, (next) => change("followUps", next))}
      <p className="taskGatesCaption">After grant actions, Aril adds a short line to this chat and sends a notification.</p>
    </section>
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Limits</h3>
      {(Object.keys(LIMITS) as (keyof typeof LIMITS)[]).map((key) => {
        const [label, min, max] = LIMITS[key];
        return <div key={key} className="taskGateField taskGateThreshold"><span className="taskGateFieldLabel">{label}</span>
          {allowed ? <CommandSelect aria-label={label} disabled={busy} value={draft.limits[key] === null ? "" : String(draft.limits[key])}
            options={[{ value: "", label: UNSET }, ...Array.from({ length: max - min + 1 }, (_, index) => ({ value: String(index + min), label: String(index + min) }))]}
            onChange={(next) => change("limits", { ...draft.limits, [key]: next === "" ? null : Number(next) })} />
            : <span className="taskGateReadOnly">{draft.limits[key] ?? UNSET}</span>}
        </div>;
      })}
    </section>
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Work rules</h3>
      {draft.workRules.length === 0 && <p className="taskGatesCaption">No work rules yet.</p>}
      {draft.workRules.map((rule, index) => <div className="taskGateField" key={index}>
        <span className="taskGateReadOnly">{KINDS[rule.kind]}: {rule.kind === "tasks" ? rule.value.join(", ") : rule.kind === "feature" ? board.features.find((feature) => feature.id === rule.value)?.name ?? rule.value : rule.value}</span>
        {allowed && <button type="button" className="commandQuietAction" aria-label={`Remove ${KINDS[rule.kind]} rule`} disabled={busy} onClick={() => change("workRules", draft.workRules.filter((_, position) => position !== index))}>Remove</button>}
      </div>)}
      {allowed && <>
        <label className="taskGateField"><span className="taskGateFieldLabel">Rule kind</span><CommandSelect aria-label="Rule kind" value={kind} disabled={busy || draft.workRules.length >= 20}
          options={(Object.keys(KINDS) as (keyof typeof KINDS)[]).map((key) => ({ value: key, label: KINDS[key] }))} onChange={(next) => { setKind(next); setValue(""); }} /></label>
        {kind === "feature" ? <CommandSelect aria-label="Feature" value={value} placeholder="Choose a feature" disabled={busy || draft.workRules.length >= 20}
          options={board.features.map((feature) => ({ value: feature.id, label: feature.name }))} onChange={setValue} />
          : <label className="taskGateField"><span className="taskGateFieldLabel">{kind === "plan" ? "Plan path" : "Rule value"}</span><input className="taskOwnInput" value={value} disabled={busy || draft.workRules.length >= 20} maxLength={kind === "tag" ? 40 : kind === "text" ? 80 : kind === "plan" ? 200 : undefined}
            placeholder={kind === "tasks" ? "T-1, T-2" : undefined} onChange={(event) => setValue(event.currentTarget.value)} /></label>}
        {kind === "tasks" && <p className="taskGatesCaption">Use comma-separated IDs of tasks on this board.</p>}
        {kind === "plan" && <p className="taskGatesCaption">A Markdown file in this repository, such as docs/plans/next.md</p>}
        <button type="button" className="commandSecondaryAction" disabled={busy || !ruleValid || draft.workRules.length >= 20} onClick={() => {
          change("workRules", [...draft.workRules, kind === "tasks" ? { kind, value: ids } : { kind, value }]); setValue("");
        }}>Add rule</button>
      </>}
    </section>
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Reviewer</h3>
      <div className="taskGateField taskGateThreshold"><span className="taskGateFieldLabel">Provider</span>
        {allowed ? <CommandSelect aria-label="Reviewer provider" value={draft.reviewer.provider ?? ""} disabled={busy}
          options={[{ value: "", label: "Any" }, { value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }]}
          onChange={(next) => change("reviewer", { ...draft.reviewer, provider: next as Settings["reviewer"]["provider"] || null })} />
          : <span className="taskGateReadOnly">{draft.reviewer.provider === "claude" ? "Claude" : draft.reviewer.provider === "codex" ? "Codex" : "Any"}</span>}
      </div>
      <label className="taskGateField"><span className="taskGateFieldLabel">Reviewer model</span>
        {allowed ? <input className="taskOwnInput" value={draft.reviewer.model ?? ""} maxLength={120} disabled={busy} aria-invalid={!modelValid}
          onChange={(event) => change("reviewer", { ...draft.reviewer, model: event.currentTarget.value || null })} /> : <span className="taskGateReadOnly">{draft.reviewer.model ?? "Any"}</span>}
      </label>
      {!modelValid && <p className="newTaskError">Use a model identifier of at most 120 characters, without spaces or paths.</p>}
      {toggle("Use a different provider than the builder", draft.reviewer.differentFromBuilder, (next) => change("reviewer", { ...draft.reviewer, differentFromBuilder: next }))}
    </section>
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Paired devices</h3>
      {desktop ? toggle("Allow paired devices to change Aril settings and memory", draft.pairedDevices, (next) => change("pairedDevices", next))
        : <p className="taskGatesCaption">{board.aril.settings.pairedDevices ? "Paired devices can change Aril settings and memory." : "Paired devices cannot change Aril settings and memory."}</p>}
    </section>
    <div className="taskHeadActions">
      {allowed && <button type="button" className="commandQuietAction" disabled={busy || !unsaved} onClick={() => { setConfirm(null); setDraft(original); }}>Discard changes</button>}
      {allowed && <button type="button" className="commandPrimaryAction" disabled={busy || !modelValid || Object.keys(changed).length === 0}
        onClick={() => void send("aril_settings_set", { settings: changed.reviewer ? { ...changed, reviewer: { ...draft.reviewer, model: model || null } } : changed }, () => {})}>Save</button>}
    </div>
    {(failure === "settings" || failure === "memory") && <p className="newTaskError" role="alert">{FAILURES[failure]}</p>}
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Memory</h3>
      <MemoryList entries={memory} editable={allowed} busy={busy} caption="What Aril remembers about how you like this repository worked. Aril proposes entries; you can edit or delete any of them."
        onAdd={(text) => memoryAction("aril_memory_add", { text })} onUpdate={(id, text) => memoryAction("aril_memory_update", { id, text })} onRemove={(id) => memoryAction("aril_memory_remove", { id })} />
    </section>
    {desktop && jev && <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Effort routing</h3>
      <p className="taskGatesCaption">With a Jev key, Aril may lower the effort you chose for simple replies, never raise it. Jev sees your message and the end of Aril&apos;s previous answer.</p>
      <p className="taskGatesCaption">{jev.state === "set" ? "Key set" : jev.state === "unset" ? "No key set" : jev.state === "unavailable" ? "This computer cannot store the key safely." : "Checking…"}</p>
      {jev.state !== "unavailable" && <>
        <label className="taskGateField"><span className="taskGateFieldLabel">Jev key</span><input className="taskOwnInput" type="password" autoComplete="off" spellCheck={false} maxLength={512}
          value={jevKey} disabled={jevBusy} aria-invalid={jevKey !== "" && !JEV_KEY_PATTERN.test(jevKey)} onChange={(event) => setJevKey(event.currentTarget.value)} /></label>
        <div className="taskHeadActions">
          <button type="button" className="commandSecondaryAction" disabled={jevBusy || !JEV_KEY_PATTERN.test(jevKey)} onClick={() => void changeJev("save")}>Save key</button>
          {jev.state === "set" && <button type="button" className="commandQuietAction" disabled={jevBusy} onClick={() => void changeJev("remove")}>Remove key</button>}
        </div>
      </>}
      {jevKey !== "" && !JEV_KEY_PATTERN.test(jevKey) && <p className="newTaskError">Use 8 to 512 characters without spaces.</p>}
      {jevFailed && <p className="newTaskError" role="alert">{jevFailed === "save" ? "The key could not be saved. Try again." : "The key could not be removed. Try again."}</p>}
    </section>}
  </div>;
}

/** One repository's settings, read from its board and saved through the fixed task actions. A board that is not ready says so in a line. */
function ArilRepositorySettings({ repositoryId, jev, arilOn }: { repositoryId: string; jev: JevKeyControl | undefined; arilOn: boolean | null }) {
  const access = useTaskEditAvailability();
  const { board, refresh } = useTasks(repositoryId);
  if (access === "pending" || board.readiness === "loading") return <p className="arilSettingsNote" role="status">Reading Aril settings…</p>;
  if (!board.aril) return <p className="arilSettingsNote">Aril settings are unavailable.</p>;
  return <ArilSettings board={{ ...board, aril: board.aril }} desktop={access === "desktop"} editable={access === "desktop" || access === "paired"} jev={jev} arilOn={arilOn}
    onAction={async (action, payload) => {
      const result = await sendTaskAction(repositoryId, action, payload);
      if (result.ok) await refresh();
      return result;
    }} />;
}

/**
 * The Aril section of Settings. The switch, the owner's memory, and the space each thread takes belong to Aril and come first. Aril's settings,
 * repository memory, and grant belong to one repository, so below them the section holds a repository choice like the chat's: the repository
 * the page was opened for, else the last one used, else the first listed. With one repository the choice is its name. The Jev key belongs
 * to the desktop app and is given only there.
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
  const options = useMemo(() => snapshot.repositories.map((repository) => ({ value: repository.id, label: repository.displayName })), [snapshot.repositories]);
  const names = useMemo(() => new Map(options.map((option) => [option.value, option.label])), [options]);
  const known = (id: string | null) => id !== null && options.some((option) => option.value === id);
  const repositoryId = [picked, initialRepositoryId, readStoredRepository()].find(known) ?? options[0]?.value ?? null;
  const choose = (id: string) => { storeRepository(id); setPicked(id); };
  return <section className="arilSettings" aria-labelledby={headingId}>
    <header>
      <h2 id={headingId}>Aril</h2>
      <p>Turn Aril on or off and say how you like to work. Grants and a repository&apos;s memory belong to one repository.</p>
    </header>
    <ArilSwitchPanel control={aril} />
    <OwnerMemorySection control={ownerMemory} />
    <ThreadSpaceSection control={space} names={names} />
    {repositoryId === null
      ? <p className="arilSettingsNote">{loading ? "Reading repositories…" : "No repositories observed yet."}</p>
      : <>
        <div className="arilSettingsRepository">
          <SettingRow label="Repository" description="The repository these settings, its memory, and its grant belong to.">
            {options.length > 1
              ? <CommandSelect aria-label="Repository" value={repositoryId} options={options} onChange={choose} />
              : <span className="commandMonoValue">{options[0].label}</span>}
          </SettingRow>
        </div>
        <ArilRepositorySettings key={repositoryId} repositoryId={repositoryId} jev={jev} arilOn={aril.state?.on ?? null} />
      </>}
  </section>;
}
