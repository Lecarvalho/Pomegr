"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { ArilSettings as Settings, TaskBoard } from "../../../shared/task-contract";
import { useTasks } from "../../tasks-store";
import { CommandIcon } from "../command-center/CommandIcon";
import { CommandSelect } from "../command-center/CommandSelect";
import { TaskDialog } from "./TaskModalFrame";
import { sendTaskAction, useTaskEditAvailability, type GrantActionResult } from "./task-desktop";
import { timeOfDay } from "./task-schedule";

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
  onAction(action: Action, payload: unknown): Promise<GrantActionResult>; onClose(): void;
};

/** The same content in the live dialog and the static design-system frames. */
export function ArilSettings({ board, desktop, editable, onAction, onClose, titleId, closeRef, initialFailure = null, initialConfirm = false }: Props & {
  titleId: string; closeRef?: RefObject<HTMLButtonElement | null>; initialFailure?: "settings" | "memory" | null; initialConfirm?: boolean;
}) {
  const allowed = editable && (desktop || board.aril.settings.pairedDevices);
  const [original] = useState(board.aril.settings);
  const [edited, setDraft] = useState(original);
  const draft = allowed ? edited : board.aril.settings;
  const [kind, setKind] = useState<keyof typeof KINDS>("tag");
  const [value, setValue] = useState("");
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<keyof typeof FAILURES | null>(initialFailure);
  const saved = board.aril.settings;
  const grant = board.aril.grant;
  const confirmation = () => ({ settings: JSON.stringify(saved), until: Date.now() + saved.limits.hours! * 3600000 });
  const [confirm, setConfirm] = useState<ReturnType<typeof confirmation> | null>(() => initialConfirm ? confirmation() : null);
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
  const toggle = (label: string, checked: boolean, onChange: (next: boolean) => void) => allowed
    ? <label className="taskCheckRow"><input type="checkbox" role="switch" checked={checked} disabled={busy} onChange={(event) => onChange(event.currentTarget.checked)} /><span>{label}</span></label>
    : <div className="taskGateRow"><span>{label}</span><span className="taskGateReadOnly">{checked ? "On" : "Off"}</span></div>;
  const choice = (label: string, options: typeof METHODS, value: string, onChange: (next: string) => void) => <div className="taskGateField taskGateThreshold"><span className="taskGateFieldLabel">{label}</span>
    {allowed ? <CommandSelect aria-label={label} disabled={busy} value={value} options={options} onChange={onChange} />
      : <span className="taskGateReadOnly">{options.find((option) => option.value === value)?.label}</span>}
  </div>;
  return <div className="taskQueueSettings" aria-busy={busy} style={{ overflowWrap: "anywhere" }}>
    <header className="taskQueueSettingsHead"><h2 id={titleId}>Aril settings</h2>
      <button ref={closeRef} type="button" className="commandIconAction" aria-label="Close" onClick={onClose}><CommandIcon name="close" /></button>
    </header>
    <section className="taskGatesPanel">
      <h3 className="taskGatesHeading">Grant</h3>
      {grant?.active ? <>
        <p className="taskGatesCaption">Active until <span className="taskCapacityValue">{grantTime(grant.endsAt)}</span> · <span className="taskCapacityValue">{grant.startsUsed}</span> of <span className="taskCapacityValue">{grant.limits.tasks}</span> tasks used</p>
        {editable && <button type="button" className="commandSecondaryAction" disabled={busy} onClick={() => void send("grant_stop", {}, () => setConfirm(null))}>Stop grant</button>}
        <p className="taskGatesCaption">Stopping takes effect at once. Running sessions continue.</p>
      </> : <>
        {notReady ? <p className="taskGatesCaption">{notReady}</p> : <p className="taskGatesCaption">Starts {saved.actions.start ? saved.actions.review ? "tasks and reviews" : "tasks" : "reviews"} that your work rules select, for {saved.limits.hours} hours, at most {saved.limits.tasks} tasks, {saved.limits.tasksAtATime} at a time.</p>}
        {unsaved && <p className="taskGatesCaption">Save your changes first.</p>}
        {allowed && !notReady && <>
          {confirming && <p className="taskGatesCaption">Aril will start sessions without asking until {grantTime(confirm.until)} or until you stop it.</p>}
          <div className="taskHeadActions"><button type="button" className="commandPrimaryAction" disabled={busy || unsaved}
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
      <button type="button" className="commandQuietAction" onClick={onClose}>Cancel</button>
      {allowed && <button type="button" className="commandPrimaryAction" disabled={busy || !modelValid || Object.keys(changed).length === 0}
        onClick={() => void send("aril_settings_set", { settings: changed.reviewer ? { ...changed, reviewer: { ...draft.reviewer, model: model || null } } : changed }, onClose)}>Save</button>}
    </div>
    {(failure === "settings" || failure === "memory") && <p className="newTaskError" role="alert">{FAILURES[failure]}</p>}
    <section className="taskGatesPanel taskSchedulePanel">
      <h3 className="taskGatesHeading">Memory</h3>
      <p className="taskGatesCaption">What Aril remembers about how you like this repository worked. Aril proposes entries; you can edit or delete any of them.</p>
      <p className="taskGatesCaption">{memory.length} of 100</p>
      {memory.length === 0 && <p className="taskGatesCaption">No memory entries yet.</p>}
      {memory.map((entry) => <div className="taskGateField" key={entry.id}>
        {allowed && editing?.id === entry.id ? <>
          <input aria-label="Edit entry" className="taskOwnInput" value={editing.text} maxLength={300} disabled={busy} onChange={(event) => setEditing({ ...editing, text: event.currentTarget.value })} />
          <div className="taskHeadActions"><button type="button" className="commandSecondaryAction" disabled={busy || !line(editing.text, 300)} onClick={() => void send("aril_memory_update", editing, () => setEditing(null))}>Save entry</button>
            <button type="button" className="commandQuietAction" disabled={busy} onClick={() => setEditing(null)}>Cancel edit</button></div>
        </> : <p className="taskGateReadOnly">{entry.text}</p>}
        {allowed && editing?.id !== entry.id && <div className="taskHeadActions">
          {removing === entry.id ? <><span>Delete this entry?</span><button type="button" className="commandSecondaryAction" disabled={busy} onClick={() => void send("aril_memory_remove", { id: entry.id }, () => setRemoving(null))}>Delete entry</button>
            <button type="button" className="commandQuietAction" disabled={busy} onClick={() => setRemoving(null)}>Keep entry</button></>
            : <><button type="button" className="commandQuietAction" disabled={busy} onClick={() => { setEditing({ id: entry.id, text: entry.text }); setRemoving(null); }}>Edit</button>
              <button type="button" className="commandQuietAction" disabled={busy} onClick={() => { setRemoving(entry.id); setEditing(null); }}>Delete</button></>}
        </div>}
      </div>)}
      {allowed && <><label className="taskGateField"><span className="taskGateFieldLabel">Add entry</span><input className="taskOwnInput" value={adding} maxLength={300} disabled={busy || memory.length >= 100} onChange={(event) => setAdding(event.currentTarget.value)} /></label>
        <button type="button" className="commandSecondaryAction" disabled={busy || memory.length >= 100 || !line(adding, 300)} onClick={() => void send("aril_memory_add", { text: adding }, () => setAdding(""))}>Add entry</button></>}
    </section>
  </div>;
}

export function ArilSettingsPanel({ board, returnFocus, onClose }: { board: TaskBoard; returnFocus: RefObject<HTMLElement | null>; onClose(): void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const access = useTaskEditAvailability();
  const { refresh } = useTasks(board.repositoryId);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const opener = returnFocus.current;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [returnFocus]);
  return <TaskDialog className="taskModalScrim taskQueueSettingsScrim" labelledBy={titleId} closeOnScrim onClose={onClose}>
    {board.aril ? <ArilSettings board={{ ...board, aril: board.aril }} desktop={access === "desktop"} editable={access === "desktop" || access === "paired"}
      onClose={onClose} titleId={titleId} closeRef={closeRef} onAction={async (action, payload) => {
        const result = await sendTaskAction(board.repositoryId, action, payload);
        if (result.ok) await refresh();
        return result;
      }} /> : <div className="taskQueueSettings"><h2 id={titleId}>Aril settings</h2><p>Aril settings are unavailable.</p><button ref={closeRef} type="button" className="commandQuietAction" onClick={onClose}>Close</button></div>}
  </TaskDialog>;
}
