"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { TaskModalChrome } from "../tasks/TaskModalFrame";
import { CompleteWhenField, RunFields, TaskTextField } from "../tasks/TaskFields";
import { DEFAULT_COMPLETE_WHEN, DEFAULT_RUN, type CompleteWhenDraft } from "../tasks/task-fields";
import type { TaskRun } from "../../../shared/task-contract";
import { Sample, Section } from "./DesignSystemKit";

// T-83 prototype: three ways to offer Create task, Create and queue, and Create and start session in the New task modal.
// Nothing here creates, queues, or starts anything. The owner picks one variant; the others are deleted with this file.

const MODELS = { claude: ["model-large", "model-small"], codex: ["model-code"] } as const;
const SAMPLE_TEXT = "Retry failed uploads with a capped backoff and cover it with a test.";
const noop = () => undefined;

type After = "create" | "queue" | "start";
type StartOutcome = "started" | "gate_held" | "tree_dirty";
type Conditions = { queueOn: boolean; start: StartOutcome };

const AFTER: readonly After[] = ["create", "queue", "start"];
const ACTION_LABELS: Record<After, string> = { create: "Create task", queue: "Create and queue", start: "Create and start session" };
const BUSY_LABELS: Record<After, string> = { create: "Creating…", queue: "Creating…", start: "Starting…" };
const CHOICE_LABELS: Record<After, string> = { create: "Keep in Backlog", queue: "Add to queue", start: "Start session" };
const START_LINES: Record<Exclude<StartOutcome, "started">, string> = {
  gate_held: "A start gate holds this task. See Start gates in Queue settings.",
  tree_dirty: "This repository has uncommitted changes. Commit or discard them, or start the task in a separate worktree, which leaves them out.",
};

function choiceHelper(after: After, queueOn: boolean): string {
  if (after === "create") return "The task waits in Backlog until you queue or start it.";
  if (after === "queue") return queueOn ? "The task goes to the end of Ready. The queue starts it when its turn comes." : "The task goes to the end of Ready. The queue is off, so nothing starts until you turn it on.";
  return "Pomegr starts the session in a new terminal window as soon as the task exists.";
}

/** What the board shows once the modal has closed. A failed start keeps the task and opens it instead. */
function outcomeLine(after: After, conditions: Conditions): string {
  if (after === "create") return "The modal closes. T-91 is in Backlog, Not queued.";
  if (after === "queue") return conditions.queueOn ? "The modal closes. T-91 is last in Ready, Queued." : "The modal closes. T-91 is last in Ready, Queued. The queue is off, so nothing starts.";
  return "The modal closes. T-91 is in In progress and its session runs in a new terminal window.";
}

function useCreateRun(conditions: Conditions) {
  const [text, setText] = useState(SAMPLE_TEXT);
  const [run, setRun] = useState<TaskRun>(DEFAULT_RUN);
  const [completeWhen, setCompleteWhen] = useState<CompleteWhenDraft>(DEFAULT_COMPLETE_WHEN);
  const [busy, setBusy] = useState<After | null>(null);
  const [done, setDone] = useState<After | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const ready = text.trim().length > 0 && busy === null;
  const submit = (after: After) => {
    if (!ready) return;
    setBusy(after);
    setDone(null);
    timer.current = window.setTimeout(() => { setBusy(null); setDone(after); }, 700);
  };
  const failedStart = done === "start" && conditions.start !== "started" ? conditions.start : null;
  return { text, setText, run, setRun, completeWhen, setCompleteWhen, busy, done, ready, submit, failedStart, reset: () => setDone(null) };
}

type CreateRun = ReturnType<typeof useCreateRun>;

function Fields({ state, children }: { state: CreateRun; children?: ReactNode }) {
  return <>
    <TaskTextField value={state.text} onChange={state.setText} readOnly={state.busy !== null} />
    <RunFields run={state.run} models={MODELS} disabled={state.busy !== null} onChange={state.setRun} />
    <CompleteWhenField draft={state.completeWhen} disabled={state.busy !== null} onDraftChange={state.setCompleteWhen} />
    {children}
  </>;
}

/** The modal, or what replaces it after the chosen action. */
function Stage({ state, conditions, subtitle, footer, children }: { state: CreateRun; conditions: Conditions; subtitle?: string; footer: ReactNode; children?: ReactNode }) {
  const titleId = useId();
  if (state.failedStart !== null) return <div className="designSystemTaskFrame designSystemTaskModalStage">
    <TaskModalChrome titleId={titleId} title="Task" subtitle="pomegr · in Backlog" onClose={state.reset}
      titleExtra={<>
        <span className="taskModalId">T-91</span>
        <span className="commandChip taskCardChip neutral">Not queued</span>
      </>}
      footer={<>
        <div className="taskModalResolve">
          <span className="taskModalNote" role="status">{START_LINES[state.failedStart]}</span>
          {state.failedStart === "tree_dirty" && <button type="button" className="commandSecondaryAction" onClick={noop}>Start in separate worktree</button>}
        </div>
        <button type="button" className="commandQuietAction" onClick={noop}>Delete task</button>
        <span className="taskModalSpacer" aria-hidden="true" />
        <button type="button" className="commandSecondaryAction" onClick={noop}>Add to queue</button>
        <button type="button" className="commandSecondaryAction" onClick={noop}>Start session</button>
        <button type="button" className="commandPrimaryAction" disabled onClick={noop}>Save</button>
      </>}>
      <Fields state={state} />
    </TaskModalChrome>
  </div>;
  if (state.done !== null) return <div className="designSystemTaskFrame designSystemCreateOutcome">
    <p role="status">{outcomeLine(state.done, conditions)}</p>
    <button type="button" className="commandSecondaryAction" onClick={state.reset}>Show the modal again</button>
  </div>;
  return <div className="designSystemTaskFrame designSystemTaskModalStage">
    <TaskModalChrome titleId={titleId} title="New task" subtitle={subtitle ?? "pomegr · in Backlog"} onClose={noop} footer={footer}>
      <Fields state={state}>{children}</Fields>
    </TaskModalChrome>
  </div>;
}

/** A: the edit footer's shape. Two Secondary actions beside the one primary. */
function ThreeActions({ conditions }: { conditions: Conditions }) {
  const state = useCreateRun(conditions);
  const label = (after: After) => state.busy === after ? BUSY_LABELS[after] : ACTION_LABELS[after];
  return <Stage state={state} conditions={conditions} footer={<>
    <span className="taskModalSpacer" aria-hidden="true" />
    <button type="button" className="commandQuietAction" disabled={state.busy !== null} onClick={noop}>Cancel</button>
    <button type="button" className="commandSecondaryAction" disabled={!state.ready} onClick={() => state.submit("queue")}>{label("queue")}</button>
    <button type="button" className="commandSecondaryAction" disabled={!state.ready} onClick={() => state.submit("start")}>{label("start")}</button>
    <button type="button" className="commandPrimaryAction" disabled={!state.ready} onClick={() => state.submit("create")}>{label("create")}</button>
  </>} />;
}

/** B: one more field decides what happens after the create, and the one primary names it. */
function AfterCreatingField({ conditions }: { conditions: Conditions }) {
  const state = useCreateRun(conditions);
  const [after, setAfter] = useState<After>("create");
  const labelId = useId();
  const helperId = useId();
  return <Stage state={state} conditions={conditions} subtitle={after === "queue" ? "pomegr · in Ready" : undefined} footer={<>
    <span className="taskModalSpacer" aria-hidden="true" />
    <button type="button" className="commandQuietAction" disabled={state.busy !== null} onClick={noop}>Cancel</button>
    <button type="button" className="commandPrimaryAction" disabled={!state.ready} onClick={() => state.submit(after)}>{state.busy !== null ? BUSY_LABELS[after] : ACTION_LABELS[after]}</button>
  </>}>
    <div className="newTaskField">
      <span id={labelId} className="newTaskEffortLabel">After creating</span>
      <div className="commandSegmented taskEffort" role="group" aria-labelledby={labelId} aria-describedby={helperId}>
        {AFTER.map((choice) => <button key={choice} type="button" aria-pressed={after === choice} disabled={state.busy !== null} onClick={() => setAfter(choice)}>{CHOICE_LABELS[choice]}</button>)}
      </div>
      <p id={helperId} className="newTaskHelper">{choiceHelper(after, conditions.queueOn)}</p>
    </div>
  </Stage>;
}

/** C: a split primary. The two extra actions open from its caret. */
function SplitPrimary({ conditions }: { conditions: Conditions }) {
  const state = useCreateRun(conditions);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const caret = useRef<HTMLButtonElement>(null);
  const choose = (after: After) => { setOpen(false); state.submit(after); caret.current?.focus({ preventScroll: true }); };
  return <Stage state={state} conditions={conditions} footer={<>
    <span className="taskModalSpacer" aria-hidden="true" />
    <button type="button" className="commandQuietAction" disabled={state.busy !== null} onClick={noop}>Cancel</button>
    <div className="designSystemSplit" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); caret.current?.focus({ preventScroll: true }); } }}>
      <button type="button" className="commandPrimaryAction" disabled={!state.ready} onClick={() => choose("create")}>{state.busy !== null ? BUSY_LABELS[state.busy] : ACTION_LABELS.create}</button>
      <button ref={caret} type="button" className="commandPrimaryAction designSystemSplitCaret" disabled={!state.ready} aria-label="More ways to create" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && <div id={menuId} className="designSystemSplitMenu" role="menu" aria-label="More ways to create">
        <button type="button" role="menuitem" autoFocus onClick={() => choose("queue")}>
          <span>{ACTION_LABELS.queue}</span>
          <small>{conditions.queueOn ? "Goes to the end of Ready." : "Goes to the end of Ready. The queue is off."}</small>
        </button>
        <button type="button" role="menuitem" onClick={() => choose("start")}>
          <span>{ACTION_LABELS.start}</span>
          <small>Opens a new terminal window now.</small>
        </button>
      </div>}
    </div>
  </>} />;
}

export function TaskCreatePrototypeSection() {
  const [queueOn, setQueueOn] = useState(false);
  const [start, setStart] = useState<StartOutcome>("started");
  const conditions: Conditions = { queueOn, start };
  const queueId = useId();
  const startId = useId();
  return <Section id="task-create-prototype" title="Prototype: create, queue, or start (T-83)" lede="Three ways to offer Create task, Create and queue, and Create and start session in the New task modal. Each modal below works on static data: type in the Task field, press an action, and read what the board would show. Nothing is created, queued, or started. One variant ships; this section is removed with the other two.">
    <div className="designSystemCreateConditions">
      <div className="newTaskField">
        <span id={queueId} className="newTaskEffortLabel">Pretend the queue is</span>
        <div className="commandSegmented" role="group" aria-labelledby={queueId}>
          <button type="button" aria-pressed={!queueOn} onClick={() => setQueueOn(false)}>Off</button>
          <button type="button" aria-pressed={queueOn} onClick={() => setQueueOn(true)}>On</button>
        </div>
      </div>
      <div className="newTaskField">
        <span id={startId} className="newTaskEffortLabel">Pretend the start</span>
        <div className="commandSegmented" role="group" aria-labelledby={startId}>
          <button type="button" aria-pressed={start === "started"} onClick={() => setStart("started")}>Works</button>
          <button type="button" aria-pressed={start === "gate_held"} onClick={() => setStart("gate_held")}>Is held by a gate</button>
          <button type="button" aria-pressed={start === "tree_dirty"} onClick={() => setStart("tree_dirty")}>Finds uncommitted changes</button>
        </div>
      </div>
    </div>
    <div className="designSystemCreateVariants">
      <Sample label="A · Three actions" note="The Task modal's footer already reads Add to queue, Start session, Save. This is the same shape: two Secondary actions and the one primary. Every action is one click and always in view. It adds no control. The footer wraps to two rows on a phone.">
        <ThreeActions conditions={conditions} />
      </Sample>
      <Sample label="B · After creating" note="One more field, a three-way Segmented control, decides what happens to the new task. The one primary names the choice, and the helper line says what it does before anything happens. It costs one more click than A, and it adds no control. The choice could be remembered for the next task.">
        <AfterCreatingField conditions={conditions} />
      </Sample>
      <Sample label="C · Split primary" note="The footer stays as it is today, with a caret on the primary that opens the two other actions. It is the quietest footer, and the two actions are hidden until the caret is pressed. The split button and its menu are a new shared control: DESIGN.md has none today.">
        <SplitPrimary conditions={conditions} />
      </Sample>
    </div>
    <p className="designSystemLede">In every variant, a start that does not happen keeps the task: the modal becomes the Task modal of that task, with the start line and the recoveries it has today. Set “Pretend the start” above and press Create and start session to see it.</p>
  </Section>;
}
