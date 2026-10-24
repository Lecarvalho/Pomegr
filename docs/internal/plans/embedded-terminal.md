# Embedded terminal for task sessions

> Status: proposed; the owner reviews this plan and the mockup before any code.
> Created: 2026-10-24.
> Scope: run the Claude Code and Codex sessions that Pomegr starts inside the desktop app, in a Terminal tab of the session, through a desktop-owned terminal host that survives app restarts and updates. It covers the boundary changes, the host, the start path, the Terminal tab, and the feasibility spike that gates all of it. The takeover brief (G14) and the owner inbox (G13) stay in the [purpose roadmap](purpose-roadmap.md); this plan gives them a place to open a session.
> Continuation owner: the product owner decides; the agent that picks up a phase records its evidence in the checkpoint.
> Authority: working plan. `AGENTS.md`, [Tasks](../architecture/tasks.md), and [desktop privacy](../architecture/privacy/desktop-and-diagnostics.md) govern shipped behavior until phase 1 changes them.
> Next task or decision: the owner accepts or rejects the boundary change, the placement, and the phase 0 spike.
> Completion criteria: the spike passes or the plan is cancelled; when it passes, a task session started from Pomegr opens in its Terminal tab, survives app quit, crash, and update, and every rule below has a test.
> Permanent destinations: `AGENTS.md` for the control boundary, [Tasks](../architecture/tasks.md) for the start transport and the host boundary, [desktop privacy](../architecture/privacy/desktop-and-diagnostics.md) for terminal output, a page in `docs/internal/design/` for the Terminal tab, and `/design-system` for its states.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Summary

Today the desktop app starts each task session in a separate terminal window (`desktop/runtime/task-dispatch.mjs`, one fixed `Start-Process` command).
The owner then has to find that window among many: the first pilot's retrospective lists this as finding 10.
This plan moves the session into Pomegr. A session that Pomegr started gets a **Terminal** tab on its session page, and the owner can type into it.
The owner reaches the tab from a task card, from the session list, or later from an inbox item.

This serves G14 Takeover in 0.9.5, measured by S1 owner time.
The terminal alone does not promise to move S1: S1 still counts observed owner turns in sessions bound to the task, and terminal keystrokes are not owner turns.

## Decisions

These were settled in a design review on 2026-10-24. The owner accepts or changes them.

| Subject | Decision |
| --- | --- |
| Where the terminal lives | A **Terminal** tab on the session page, opened on demand. No terminal dock on the Tasks page and no Terminals navigation entry, because a wall of live terminals invites watching. |
| Unit | One terminal per session. A send-back (G9) or takeover starts a new session with its own terminal, linked to the same task and worktree. |
| Who writes to it | Only the owner's own keyboard and paste, through trusted desktop IPC. Aril, the queue, the MCP tools, and the monitor have no way to write to a terminal. |
| Ending a session | Pomegr has no End session action. Closing the tab, switching sessions, or closing the window only hides the view. The owner can still exit the CLI or press Ctrl+C through the terminal. |
| Session state | "Needs input", "Working", and completion come from observation and task reports, never from parsing terminal text. A process exit is shown as an exit, never as done. |
| Lifetime | A detached desktop-owned terminal host keeps sessions running through app quit, app crash, and update. Desktop main reconnects to its own host. Reconnection is never an attach to a process that Pomegr did not start. |
| Default | A desktop setting **Open task sessions in Pomegr**, on by default once the spike passes. It applies to future starts only. Off keeps today's external window. |
| Sessions not started in the host | No Terminal tab. A quiet chip in the session's chip row says "External terminal" only when provenance shows it; otherwise "No managed terminal". |
| Paired phone | No terminal. A managed session shows "Terminal available in the desktop app". |
| Placement | Inside G14 in 0.9.5, after 0.9.0 ships. Phase 0 may run earlier as a spike that merges nothing. |

## Boundary changes

Phase 1 makes these changes in one pull request, before any code that depends on them.

1. **Control.** `AGENTS.md` says that dispatch never stops, attaches to, answers, or approves work in a running session. The new rule adds one exception: in the desktop app, the owner's own keyboard input reaches a session that Pomegr started in its terminal host. No agent, queue, tool, or monitor path may write to a terminal, and Pomegr never ends one.
   This is different from the deferred idea of managed messages to a running session, which stays deferred.
2. **Privacy.** Terminal output holds raw prompts, responses, and tool output. A new section of [desktop privacy](../architecture/privacy/desktop-and-diagnostics.md) lists it as the second exception to the raw-content rule, after the agent chat:
   - It flows only from the terminal host to desktop main to the trusted desktop renderer.
   - It is held only in memory: a bounded scrollback for each session in the host, and the renderer's view.
   - It is never written to disk, logged, sent to the monitor, cached, served over HTTP, included in `/api/state`, read by Aril or an MCP tool, or sent to a paired device.
3. **Start transport.** [Tasks: Starting a session](../architecture/tasks.md#starting-a-session) gains the embedded transport beside the external window, and the Boundaries table gains rows for the host pipe and the terminal IPC channels.

## Terminal host

The host is a small Node process that owns the ConPTY sessions. Desktop main starts it detached, so it outlives the app.

- **Runtime copy.** The host runs from a copy under the user's app data folder, one folder per app build, holding its executable, its script, and the native PTY files. An update never overwrites a folder that a running host uses, so an NSIS install does not fail on locked files.
- **Versions.** Desktop main and the host exchange a protocol version first. When they match, desktop main reconnects. When they do not, the old host keeps its sessions running, the app shows them as temporarily inaccessible, and new starts use a new host. The old host exits when its last session ends.
- **Channel.** A named pipe that only the current user's account can open. A random token for each host is kept in a file that only the user can read. The token never appears in arguments or logs, and the host authenticates a client before it lists or attaches anything.
- **Commands.** The host accepts only: create (from a start plan that desktop main validated), list, attach, input, resize, and detach. It has no kill command.
- **Bounds.** Fixed caps on message size, scrollback for each session, total host memory, and the number of sessions. Output uses flow control. A slow or disconnected renderer never blocks the provider process: the host drops the oldest scrollback first.
- **Exit.** The host exits by itself only when it has no live process and no client for 60 seconds. Pomegr never kills a host that has a live session.

## Start path

- `task-dispatch.mjs` keeps everything up to the launch: the native confirmation, the start plan, its validation, the worktree, `POMEGR_TASK_TOKEN`, and the rollback on failure. Only the launch transport changes.
- The embedded launch passes the same executable, argument array, and directory to the host's create command. Task text still never enters a command line or a path.
- The terminal binds to the session only after the session's first report binds its dispatch token (see [Session binding](../architecture/tasks.md#session-binding)). A PTY that exists does not prove a session.
- Before that binding, a manual start shows the terminal in a start view of the task, with "Waiting for the session to report". Once the session binds, the view moves to the session's Terminal tab.
- When an embedded launch fails and it is certain that no session started, the app offers the external window. When the result is ambiguous, it never retries externally, because that could start the work twice.
- A queued start never takes focus or opens the Terminal tab. The session simply has a Terminal tab when the owner opens it.

## Terminal tab

- Desktop app only, decided at first render like the other desktop-only actions.
- The tab renders the stream with a terminal emulator in the renderer and sends keys, paste, and resize back through fixed IPC channels.
- The tab is one terminal surface. The CLI draws its own input box, and keys go straight to the process. Pomegr adds no chat field.
- States: starting, before binding; live; reconnecting after an app restart; host unavailable (the session may still run, but reconnection is unavailable, and an external window cannot recover it); incompatible host version (the session runs, temporarily inaccessible); process exited, with its exit code.
- Entry points: an **Open terminal** action on the task card of a session that has one, the session list, and later the inbox. The inbox distinguishes **Open terminal** for an existing session from **Take over**, which starts a new session from a brief after the start confirmation (G14).
- A design page in `docs/internal/design/` and `/design-system` samples cover each state.

## Failure behavior

| Case | Behavior |
| --- | --- |
| The app quits or crashes | Sessions keep running in the host. The next app start reconnects and shows the scrollback that the host still holds. |
| An update installs | The new app uses a new host folder. Sessions of a compatible host reconnect; others stay running and show as temporarily inaccessible. |
| The host cannot be reached | The tab shows "Reconnection unavailable". Observation of the session continues as today. |
| The renderer is slow or gone | Output keeps flowing to the host's bounded scrollback. The provider never waits for the view. |
| The computer restarts | The host and its sessions end, as an external window would. The provider's own resume is the owner's path back. |

## Work and verification

- [ ] **Phase 0, spike (gate).** A throwaway branch that merges nothing. Proves, in a packaged build on Windows: a detached host with ConPTY runs Claude Code and Codex with correct rendering, resize, paste, Ctrl+C, and Unicode; sessions survive app quit, app crash, a packaged update, and a protocol mismatch; the native module unpacks, is signed, and passes artifact inspection and legal notices (`desktop/packaging/asar-policy.mjs`, `artifact-policy.mjs`, `legal-notices.mjs`); the updater path (`desktop/runtime/updater.mjs` `quitAndInstall`) does not wait for or kill the host. Any live provider run in the spike follows the probe rules in `AGENTS.md`. If the spike fails, external launch stays and this plan is cancelled or reshaped.
- [ ] **Phase 1, contracts.** The three boundary changes above, with the owner's decision recorded in the [purpose roadmap](purpose-roadmap.md).
- [ ] **Phase 2, host.** The host, its runtime copy, pipe, token, commands, bounds, and idle exit. Tests use a fake PTY and synthetic output only.
- [ ] **Phase 3, start path.** The embedded transport, the setting, binding to the confirmed session, and no external retry after an ambiguous launch. Tests cover both transports and the rollback.
- [ ] **Phase 4, Terminal tab.** The tab, its states, the task card action, the design page, and the samples. A packaged smoke check opens a synthetic session's terminal.
- [ ] **Phase 5, acceptance.** The owner runs real tasks with the setting on for a week, through at least one update, and records any lost session.

## Mockup

The design review produced an interactive mockup with synthetic data that steps through every state above. It lives outside the repository until the owner accepts the design; phase 4 turns it into `/design-system` samples.

## Continuation checkpoint

2026-10-24: design converged in review; the mockup is ready for the owner. Next action: the owner decides on the boundary change, the placement, and the spike.
