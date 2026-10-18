"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import type { ArilPilot, ArilPilotActivation, ArilPilotProvider, ArilPilotRun } from "../../../shared/aril-pilot-contract";
import { activateArilPilot, callArilPilot } from "../../aril-pilot-client";
import { TaskDialog, TaskModalChrome } from "./TaskModalFrame";

type Props = { repositoryId: string; tasks: Task[]; desktop: boolean; onReconcile?: (taskId: string) => Promise<boolean> };
type RunRow = { provider: ArilPilotProvider | ""; model: string };
const providerLabel = (provider: ArilPilotProvider) => provider === "claude" ? "Claude Code" : "Codex";

function dateLine(value: string | null): string {
  if (!value) return "None scheduled";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function ArilPilotControl({ repositoryId, tasks, desktop, onReconcile }: Props) {
  const [pilot, setPilot] = useState<ArilPilot | null>(null);
  const [history, setHistory] = useState<ArilPilot[]>([]);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState(false);
  const [goal, setGoal] = useState("");
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [durationHours, setDurationHours] = useState(24);
  const [roundLimit, setRoundLimit] = useState(20);
  const [startLimit, setStartLimit] = useState(3);
  const [concurrency, setConcurrency] = useState(1);
  const [minIntervalMinutes, setMinIntervalMinutes] = useState(5);
  const [allowedRuns, setAllowedRuns] = useState<RunRow[]>([]);
  const [inference, setInference] = useState<RunRow>({ provider: "", model: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deadlinePreview, setDeadlinePreview] = useState<string | null>(null);
  const titleId = useId();
  const opener = useRef<HTMLButtonElement>(null);

  const read = useCallback(async () => {
    if (!desktop) return;
    const result = await callArilPilot("read", { repositoryId });
    if (result.ok) { setPilot(result.pilot); setHistory(result.history ?? []); }
    else if (result.error !== "desktop_only") setError("Pilot status is unavailable right now.");
  }, [desktop, repositoryId]);

  useEffect(() => {
    if (!desktop) return;
    const firstRead = window.setTimeout(() => { void read(); }, 0);
    const timer = window.setInterval(() => { void read(); }, 10_000);
    return () => { window.clearTimeout(firstRead); window.clearInterval(timer); };
  }, [desktop, read]);

  const openSetup = () => {
    setGoal(""); setTaskIds([]); setDurationHours(24); setRoundLimit(20); setStartLimit(3); setConcurrency(1); setMinIntervalMinutes(5);
    setAllowedRuns([]); setInference({ provider: "", model: "" });
    setReview(false); setDeadlinePreview(null); setError(null); setOpen(true);
  };

  const toggleTask = (id: string, checked: boolean) => {
    setTaskIds((current) => checked ? (current.length >= 32 ? current : [...current, id]) : current.filter((taskId) => taskId !== id));
  };
  const updateRun = (index: number, patch: Partial<RunRow>) => setAllowedRuns((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  const payload = useMemo<ArilPilotActivation>(() => ({
    repositoryId, goal: goal.trim(), taskIds, durationHours, roundLimit, startLimit, concurrency, minIntervalMinutes,
    allowedRuns: allowedRuns.filter((run) => run.provider).map((run): ArilPilotRun => ({ provider: run.provider as ArilPilotProvider, model: run.model.trim() || null })),
    inference: { provider: inference.provider as ArilPilotProvider, model: inference.model.trim() || null },
  }), [repositoryId, goal, taskIds, durationHours, roundLimit, startLimit, concurrency, minIntervalMinutes, allowedRuns, inference]);
  const valid = payload.goal.length > 0 && payload.taskIds.length > 0 && payload.allowedRuns.length > 0
    && allowedRuns.every((run) => run.provider !== "") && inference.provider !== ""
    && payload.durationHours >= 1 && payload.durationHours <= 168 && payload.roundLimit >= 1 && payload.roundLimit <= 100
    && payload.startLimit >= 1 && payload.startLimit <= 32 && payload.concurrency >= 1 && payload.concurrency <= Math.min(4, payload.startLimit)
    && payload.minIntervalMinutes >= 5 && payload.minIntervalMinutes <= 1440;

  const activate = async () => {
    setBusy(true); setError(null);
    const result = await activateArilPilot(payload);
    setBusy(false);
    if (result.ok) { setPilot(result.pilot); setHistory(result.history ?? history); setOpen(false); setReview(false); }
    else setError(result.error === "limit" ? "The pilot history limit has been reached. No new grant was created."
      : result.error === "conflict" ? "A pilot changed before this grant could be activated. Review the current status and try again." : "The pilot could not be activated. Check the settings and try again.");
  };

  const control = async (operation: "pause" | "revoke") => {
    const action = operation === "pause" ? "Pause" : "Revoke";
    if (!window.confirm(`${action} the Aril pilot for this repository?`)) return;
    setBusy(true); setError(null);
    const result = await callArilPilot(operation, { repositoryId });
    setBusy(false);
    if (result.ok) { setPilot(result.pilot); setHistory(result.history ?? history); }
    else setError("The pilot could not be updated. Try again.");
  };

  const reconcile = async (taskId: string) => {
    const confirmed = window.confirm(`Only continue after checking that no session started for ${taskId}. Requeue ${taskId} and revoke this Aril pilot grant? Any existing session will continue running; Pomegr will not stop it.`);
    if (!confirmed || !onReconcile || busy) return;
    setBusy(true); setError(null);
    try {
      const requeued = await onReconcile(taskId);
      if (!requeued) {
        setError(`Task ${taskId} could not be requeued. The pilot grant remains unchanged.`);
        return;
      }
      const revoked = await callArilPilot("revoke", { repositoryId });
      if (revoked.ok) { setPilot(revoked.pilot); setHistory(revoked.history ?? history); }
      else setError(`Task ${taskId} was requeued, but the pilot grant could not be revoked. Revoke it before creating another grant.`);
    } catch {
      setError(`Task ${taskId} could not be reconciled. Check the task and pilot status before trying again.`);
    } finally {
      setBusy(false);
    }
  };

  if (!desktop) return <p className="taskBoardNote taskPilotUnavailable">Aril pilot is available in the Pomegr desktop app only.</p>;

  const active = pilot?.status === "active";
  const hasExisting = pilot !== null && ["active", "paused", "needs_you"].includes(pilot.status);
  const reconcileTaskIds = pilot?.status === "needs_you" && onReconcile
    ? [...new Set(pilot.receipts.filter((receipt) => receipt.action === "start"
      && (/^uncertain$/iu.test(receipt.status) || /unbound|needs_binding/iu.test(receipt.status))
      && receipt.taskId !== null && pilot.taskIds.includes(receipt.taskId)
      && tasks.some((task) => task.id === receipt.taskId && task.session === null))
      .map((receipt) => receipt.taskId as string))]
    : [];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return <>
    <button ref={opener} type="button" className="commandSecondaryAction" onClick={openSetup} disabled={busy || hasExisting}>
      {pilot?.status === "active" ? "Aril pilot running" : pilot?.status === "paused" ? "Aril pilot paused" : pilot?.status === "needs_you" ? "Aril pilot needs you" : "Aril pilot"}
    </button>
    {pilot && <section className="taskPilotStatus panel" aria-label="Aril pilot status" aria-live="polite">
      <div className="taskPilotStatusHead">
        <h2>Aril pilot · {pilot.status.replace("_", " ")}</h2>
        {active && <button type="button" className="commandSecondaryAction" disabled={busy} onClick={() => void control("pause")}>Pause</button>}
        {hasExisting && <button type="button" className="commandSecondaryAction" disabled={busy} onClick={() => void control("revoke")}>Revoke</button>}
      </div>
      <p className="taskPilotStatusMeta">Expires {dateLine(pilot.expiresAt)} · Rounds {pilot.roundsUsed}/{pilot.roundLimit} · Starts {pilot.startsUsed}/{pilot.startLimit} · Next wake {dateLine(pilot.nextWakeAt)}</p>
      <details className="taskPilotGrantDetails"><summary>Grant details</summary>
        <p><strong>Goal:</strong> {pilot.goal}</p>
        <p><strong>Selected tasks:</strong> {pilot.taskIds.join(", ")}</p>
        <p><strong>Allowed runs:</strong> {pilot.allowedRuns.map((run) => `${providerLabel(run.provider)} · ${run.model ?? "Default model"}`).join("; ")}</p>
        <p><strong>Inference:</strong> {providerLabel(pilot.inference.provider)} · {pilot.inference.model ?? "Default model"}</p>
        <p><strong>Limits:</strong> concurrency {pilot.concurrency} · at least {pilot.minIntervalMinutes} minutes between rounds</p>
      </details>
      {pilot.waiting && <p className="taskPilotWaiting"><strong>Waiting:</strong> {pilot.waiting}</p>}
      {pilot.status === "needs_you" && <p className="taskPilotNeedsYou">Aril needs you to review this pilot.</p>}
      {pilot.status === "paused" && <p className="taskPilotWaiting">Revoke this paused grant before creating a new one.</p>}
      {pilot.status === "needs_you" && <p className="taskPilotWaiting">Revoke this grant before creating a new one.</p>}
      {reconcileTaskIds.map((taskId) => <button key={taskId} type="button" className="commandSecondaryAction" disabled={busy} onClick={() => void reconcile(taskId)}>Reconcile {taskId}</button>)}
      {pilot.summary && <p className="taskPilotSummary"><strong>Final summary:</strong> {pilot.summary}</p>}
      {pilot.receipts.length > 0 && <div className="taskPilotReceipts">
        <h3>Decisions and receipts</h3>
        <ol>{[...pilot.receipts].reverse().map((receipt, index) => <li key={`${receipt.at}-${receipt.action}-${index}`}>
          <span className="taskPilotReceiptTop">{receipt.action.replaceAll("_", " ")} · {receipt.status.replaceAll("_", " ")}{receipt.taskId ? ` · ${receipt.taskId}` : ""}</span>
          <span>{receipt.reason}</span>
          <span className="taskPilotReceiptMeta">{receipt.provider ?? "No provider"}{receipt.model ? ` · ${receipt.model}` : ""} · Evidence {receipt.evidenceRevision} · {dateLine(receipt.at)}</span>
        </li>)}</ol>
      </div>}
    </section>}
    {history.length > 0 && <details className="taskPilotHistory"><summary>Previous grants ({history.length})</summary>
      <ol>{history.map((entry) => <li key={`${entry.id}-${entry.revision}`}>
        <strong>{entry.status.replaceAll("_", " ")} · {dateLine(entry.expiresAt)}</strong>
        <span>{entry.summary ?? entry.goal}</span>
        {entry.receipts.length > 0 && <span>{entry.receipts.length} saved decisions and receipts</span>}
      </li>)}</ol>
    </details>}
    {error && !open && <p className="taskBoardError" role="alert">{error}</p>}
    {open && <TaskDialog className="taskModalScrim" labelledBy={titleId} closeOnScrim onClose={() => { setOpen(false); setReview(false); }}>
      <TaskModalChrome titleId={titleId} title="Aril pilot" subtitle={review ? "Review the finite grant" : "Configure a finite grant"} closeRef={undefined}
        onClose={() => { setOpen(false); setReview(false); }} footer={<>
          {review ? <>
            <button type="button" className="commandSecondaryAction" disabled={busy} onClick={() => setReview(false)}>Back to settings</button>
            <button type="button" className="commandPrimaryAction taskModalConfirm" disabled={!valid || busy} onClick={() => void activate()}>{busy ? "Activating…" : "Confirm and activate pilot"}</button>
          </> : <>
            <button type="button" className="commandSecondaryAction" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="commandPrimaryAction taskModalConfirm" disabled={!valid} onClick={() => { setDeadlinePreview(new Date(Date.now() + durationHours * 60 * 60_000).toISOString()); setReview(true); }}>Review grant</button>
          </>}
        </>}>
        {review ? <div className="taskPilotReview">
          <h3>Grant review</h3>
          <p><strong>Goal</strong><span>{payload.goal}</span></p>
          <p><strong>Selected tasks</strong><span>{payload.taskIds.map((id) => `${id} · ${taskById.get(id)?.text.split("\n")[0] ?? "Task no longer on board"}`).join("; ")}</span></p>
          <p><strong>Deadline</strong><span>{deadlinePreview ? dateLine(deadlinePreview) : `${durationHours} hours from activation`} ({durationHours} hours from activation)</span></p>
          <p><strong>Granted actions</strong><span>Start a new session for a selected task, or fill an unset task run configuration.</span></p>
          <p><strong>Allowed task runs</strong><span>{payload.allowedRuns.map((run) => `${providerLabel(run.provider)} · ${run.model ?? "Default model"}`).join("; ")}</span></p>
          <p><strong>Inference run</strong><span>{providerLabel(payload.inference.provider)} · {payload.inference.model ?? "Default model"}</span></p>
          <p><strong>Limits</strong><span>{payload.roundLimit} rounds · {payload.startLimit} starts · concurrency {payload.concurrency} · at least {payload.minIntervalMinutes} minutes between rounds</span></p>
          <p className="taskPilotReviewNotice">This grant is finite. Confirming it allows Aril to take only the actions listed above until the deadline or a limit is reached.</p>
        </div> : <div className="taskPilotForm">
          <label className="newTaskField"><span>Goal</span><textarea value={goal} maxLength={2000} onChange={(event) => setGoal(event.target.value)} placeholder="Describe the outcome Aril should pursue" /></label>
          <fieldset className="taskPilotTaskPicker"><legend>Existing tasks · select up to 32</legend>
            <div className="taskPilotTaskList">{tasks.map((task) => <label key={task.id}>
              <input type="checkbox" checked={taskIds.includes(task.id)} disabled={!taskIds.includes(task.id) && taskIds.length >= 32} onChange={(event) => toggleTask(task.id, event.currentTarget.checked)} />
              <span><code>{task.id}</code> {task.text.split("\n")[0]}</span>
            </label>)}</div>
            <small>{taskIds.length} of 32 selected</small>
          </fieldset>
          <div className="taskPilotGrid">
            <label className="newTaskField"><span>Expires after (hours)</span><input type="number" min={1} max={168} value={durationHours} onChange={(event) => setDurationHours(Number(event.target.value))} /></label>
            <label className="newTaskField"><span>Round limit</span><input type="number" min={1} max={100} value={roundLimit} onChange={(event) => setRoundLimit(Number(event.target.value))} /></label>
            <label className="newTaskField"><span>Start limit</span><input type="number" min={1} max={32} value={startLimit} onChange={(event) => setStartLimit(Number(event.target.value))} /></label>
            <label className="newTaskField"><span>Concurrency</span><input type="number" min={1} max={Math.min(4, startLimit)} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label>
            <label className="newTaskField"><span>Minimum interval between rounds (minutes)</span><input type="number" min={5} max={1440} value={minIntervalMinutes} onChange={(event) => setMinIntervalMinutes(Number(event.target.value))} /></label>
          </div>
          <fieldset className="taskPilotRunSet"><legend>Allowed task provider and model pairs</legend>
            <p className="newTaskHelper">Choose each allowed provider. Leave its model blank to allow that provider&apos;s default model.</p>
            {allowedRuns.map((run, index) => <div className="taskPilotRunRow" key={index}>
              <label><span className="visuallyHidden">Provider</span><select value={run.provider} onChange={(event) => updateRun(index, { provider: event.target.value as ArilPilotProvider | "" })}><option value="">Choose provider</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
              <label><span className="visuallyHidden">Model</span><input value={run.model} maxLength={120} onChange={(event) => updateRun(index, { model: event.target.value })} placeholder="Default model" /></label>
              <button type="button" className="commandQuietAction" disabled={allowedRuns.length === 1} onClick={() => setAllowedRuns((rows) => rows.filter((_, i) => i !== index))}>Remove</button>
            </div>)}
            <button type="button" className="commandSecondaryAction" disabled={allowedRuns.length >= 32} onClick={() => setAllowedRuns((rows) => [...rows, { provider: "", model: "" }])}>Add allowed pair</button>
          </fieldset>
          <fieldset className="taskPilotRunSet"><legend>Inference run</legend>
            <p className="newTaskHelper">Choose the provider Aril may use for its planning runs; a blank model selects that provider&apos;s default.</p>
            <div className="taskPilotRunRow">
              <label><span className="visuallyHidden">Inference provider</span><select value={inference.provider} onChange={(event) => setInference((run) => ({ ...run, provider: event.target.value as ArilPilotProvider | "" }))}><option value="">Choose provider</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
              <label><span className="visuallyHidden">Inference model</span><input value={inference.model} maxLength={120} onChange={(event) => setInference((run) => ({ ...run, model: event.target.value }))} placeholder="Default model" /></label>
            </div>
          </fieldset>
        </div>}
        {error && <p className="newTaskError" role="alert">{error}</p>}
      </TaskModalChrome>
    </TaskDialog>}
  </>;
}
