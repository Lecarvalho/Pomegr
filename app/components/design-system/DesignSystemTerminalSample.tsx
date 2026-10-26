"use client";

import { SessionTerminalSurface, type HistoryPage } from "../dashboard/session-terminal/SessionTerminalPanel";
import { ManagedTerminalSurface, type TerminalViewState } from "../dashboard/session-terminal/ManagedTerminalPanel";
import { Sample, Section } from "./DesignSystemKit";

const history: HistoryPage = {
  status: "ok", reset: false, cursor: null, older: null,
  messages: [
    { kind: "owner", at: null, text: "Keep the last good session state visible while a refresh is incomplete." },
    { kind: "agent", at: null, text: "I will check when the cached revision is replaced and add a regression test." },
    { kind: "agent", at: null, text: "[PR #927](https://github.com/o/r/pull/927) ready, [CI passed](https://github.com/o/r/actions/runs/4013)." },
    { kind: "tool", at: null, name: "Read", outcome: "completed" },
    { kind: "tool", at: null, name: "Edit", outcome: "failed" },
    { kind: "tool", at: null, name: "Test", outcome: "pending" },
    { kind: "agent", at: null, text: "## Saved revision\n\nThe **previous revision** stays visible until its `replacement` commits.\n\n```ts\nconst revision = previous;\ncommit(replacement);\n```\n\n- Keep the last good state\n- Replace after validation" },
    { kind: "agent", at: null, text: "| Proof | Result |\n|---|---|\n| `npm test` | Pass |\n| `npm run lint` | Pass |\n\n> Keep *validated evidence*; ~~partial replacement~~ is removed.\n\n---\n\n- Validation\n  - [x] Retain revision\n  - [ ] Review replacement" },
  ],
};
const ignore = () => {};
const samples: { label: string; page: HistoryPage | null; live?: boolean; failed?: boolean; busy?: boolean; canContinue?: boolean; continueMessage?: string }[] = [
  { label: "History", page: { ...history, older: { fingerprint: "synthetic", offset: 100 } } },
  { label: "Live with Refresh", page: history, live: true },
  { label: "Ended", page: history, canContinue: true },
  { label: "Continue refused", page: history, continueMessage: "Read-only · Continue unavailable: working directory is missing" },
  { label: "Empty", page: { ...history, messages: [] } },
  { label: "Unavailable", page: { ...history, messages: [], status: "missing" } },
  { label: "Failed", page: null, failed: true },
  { label: "Reading", page: null, busy: true },
];
const managed: { label: string; state: TerminalViewState }[] = [
  { label: "Managed live", state: "live" }, { label: "Starting before binding", state: "starting" },
  { label: "Reconnecting", state: "reconnecting" }, { label: "Host unavailable", state: "host_unavailable" },
  { label: "New launch failed", state: "failed" }, { label: "Incompatible host", state: "incompatible_host" },
];

export function SessionTerminalSection() {
  return <Section id="session-terminal" title="Session Terminal" lede="Desktop-only managed terminals and saved history. These synthetic samples read no session data and start no process.">
    <div className="designSystemGrid">{managed.map(({ label, state }) => <Sample key={state} label={label} note="Synthetic CLI output; the provider draws its own input inside this surface.">
      <ManagedTerminalSurface state={state} fill={false} onRetry={state === "failed" ? ignore : undefined}>
        {(state === "live" || state === "starting") && <pre className="sessionTerminalOutput">{state === "starting" ? "Starting in the task worktree…\nInitializing session…" : "Provider CLI / Pomegr · T-123\n\n> Keep the last good revision during refresh.\n\nI will check the refresh coordinator and add regression coverage.\n\nRunning focused tests…"}</pre>}
      </ManagedTerminalSurface>
    </Sample>)}
      <Sample label="Queued start" note="A queue start opens no view and takes no focus."><p className="sessionTerminalMuted">T-125 · Waiting in terminal</p><p>Open the task to see its starting terminal. A bound task keeps its existing Open session action.</p></Sample>
    </div>
    <div className="designSystemGrid">{samples.map(({ label, page, live = false, failed = false, busy = false, canContinue = false, continueMessage }) => <Sample key={label} label={label} note="Synthetic messages; sample controls do not read history.">
      <SessionTerminalSurface page={page} live={live} failed={failed} busy={busy} onRefresh={ignore} onEarlier={ignore} onContinue={canContinue ? ignore : undefined} continueMessage={continueMessage} onOpenLink={ignore} />
    </Sample>)}</div>
  </Section>;
}
