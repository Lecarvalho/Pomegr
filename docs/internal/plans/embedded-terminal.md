# Sessions inside Pomegr: terminal, history, and continue

> Status: proposed; the owner reviews this plan and the mockup before any code.
> Created: 2026-10-24.
> Scope: keep the owner's coding-agent sessions inside the desktop app. Sessions that Pomegr starts run in a Terminal tab of the session, through a desktop-owned terminal host that survives app restarts and updates. The same Terminal tab shows any other session's saved history read-only, and an ended session can be continued in it through the provider's own resume. It covers the boundary changes, the host, the start and resume paths, the Terminal tab, and the feasibility spike that gates the terminal. The takeover brief (G14) and the owner inbox (G13) stay in the [purpose roadmap](purpose-roadmap.md); this plan gives them a place to open a session.
> Continuation owner: the product owner decides; the agent that picks up a phase records its evidence in the checkpoint.
> Authority: working plan. `AGENTS.md`, [Tasks](../architecture/tasks.md), [session evidence privacy](../architecture/privacy/session-evidence.md), and [desktop privacy](../architecture/privacy/desktop-and-diagnostics.md) govern shipped behavior until each phase changes them.
> Next task or decision: the owner accepts or rejects the boundary changes, the placement, and the phase 0 spike.
> Completion criteria: the read-only history ships; the spike passes or the terminal part is cancelled; when it passes, a session started from Pomegr opens in its Terminal tab, survives app quit, crash, and update, an ended session continues in the terminal, and every rule below has a test.
> Permanent destinations: `AGENTS.md` for the control boundary, [Tasks](../architecture/tasks.md) for the start and resume paths and the host boundary, [session evidence privacy](../architecture/privacy/session-evidence.md) for the history read, [desktop privacy](../architecture/privacy/desktop-and-diagnostics.md) for terminal output, the provider contract for the history read, a page in `docs/internal/design/` for the Terminal tab, and `/design-system` for its states.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Summary

Today the desktop app starts each task session in a separate terminal window (`desktop/runtime/task-dispatch.mjs`, one fixed `Start-Process` command).
The owner then has to find that window among many: the first pilot's retrospective lists this as finding 10.
Once a session ends, Pomegr shows what it did but not what was said, and going back to it means finding the right folder and running the provider's resume by hand.

This plan keeps sessions inside Pomegr, in three parts:

1. **Terminal.** A session that Pomegr starts runs in a **Terminal** tab on its session page, and the owner types into it. No external window opens.
2. **History.** Any other session the provider still keeps on disk shows its exchanged messages in the same Terminal tab, read-only, read when the tab opens.
3. **Continue.** An ended session has a **Continue** action that turns its read-only terminal live through the provider's own resume, so the owner can keep talking.

This serves G14 Takeover in 0.9.5, measured by S1 owner time.
It does not promise to move S1 on its own: S1 counts observed owner turns in sessions bound to the task, and terminal keystrokes are not owner turns.

## Decisions

These were settled in a design review on 2026-10-24, with the owner's later changes. The owner accepts or changes them.

| Subject | Decision |
| --- | --- |
| Where sessions live | One **Terminal** tab on every session's page: interactive for a session running in Pomegr's host, read-only for any other session (owner, 2026-10-24). No separate Conversation tab, no terminal dock on the Tasks page, no Terminals page, and no terminal list, because a wall of live terminals invites watching (owner, 2026-10-24). |
| External windows | None. New and continued sessions open only in Pomegr's terminal, because the owner does not want standalone terminal windows (owner, 2026-10-24). A failed launch offers a retry in the terminal, and only when it is certain that no session started. |
| Unit | One terminal per session. A send-back (G9) or takeover starts a new session with its own terminal, linked to the same task and worktree. |
| Who writes to a terminal | Only the owner's own keyboard and paste, through trusted desktop IPC. Aril, the queue, the MCP tools, and the monitor have no way to write to a terminal. |
| Ending a session | Pomegr has no End session action. Closing a tab or the window only hides the view. The owner ends a session inside the CLI, with `/exit` or Ctrl+C. |
| Session state | "Needs input", "Working", and completion come from observation and task reports, never from parsing terminal text. A process exit is shown as one quiet line with its exit code, never as done. |
| Lifetime | A detached desktop-owned terminal host keeps sessions running through app quit, app crash, and update. Desktop main reconnects to its own host. Reconnection is never an attach to a process that Pomegr did not start. |
| After an exit | The Terminal tab turns read-only and shows the saved history, with **Continue**. The host keeps no exited output. |
| Session switching | No session switcher on the session page; the owner moves between sessions through the session list (owner, 2026-10-24). |
| Terminal look | One terminal surface. The CLI draws its own input box, docked at the bottom of the panel in the mockup (owner, 2026-10-24). The caret shows focus, and the terminal draws no focus ring (owner, 2026-10-24). |
| Paired phone | No terminal, no history, and no Continue. A managed session shows "Terminal available in the desktop app". |
| Placement | Inside G14 in 0.9.5, after 0.9.0 ships. The read-only history needs no native module and may ship earlier. Phase 0 may run earlier as a spike that merges nothing. |

## Boundary changes

Each change lands in its own pull request, before any code that depends on it.

1. **Control.** `AGENTS.md` says that dispatch never stops, attaches to, answers, or approves work in a running session. The new rule adds two exceptions, both in the desktop app only:
   - the owner's own keyboard input reaches a session that Pomegr started in its terminal host;
   - after the owner confirms, Pomegr resumes an **ended** session in its terminal host through the provider's own resume. It never resumes a session that is running or whose state is unknown.

   No agent, queue, tool, or monitor path may write to a terminal or start a resume, and Pomegr never ends a session. This is different from the deferred idea of managed messages to a running session, which stays deferred.
2. **History privacy.** A session's history holds raw prompts and responses. A new section of [session evidence privacy](../architecture/privacy/session-evidence.md) lists the history read as an exception to the raw-content rule:
   - The provider adapter reads the provider's own session file when the owner opens the tab; the app never reads a provider file or schema.
   - It returns owner messages and agent replies, and each tool call as one fixed line with its tool name and outcome. It never returns tool arguments, tool results, or reasoning.
   - The read is bounded and paginated, through an authenticated internal POST route that only desktop main may call, like the scorecard read. It is never a GET, so the rule that a GET serves only committed caches holds.
   - Nothing is cached, stored, logged, or kept in browser storage. It never reaches `/api/state`, Aril, an MCP tool, or a paired device.
3. **Terminal privacy.** Terminal output holds raw prompts, responses, and tool output. A new section of [desktop privacy](../architecture/privacy/desktop-and-diagnostics.md) lists it:
   - It flows only from the terminal host to desktop main to the trusted desktop renderer.
   - It is held only in memory: a bounded scrollback for each live session in the host, and the renderer's view.
   - It is never written to disk, logged, sent to the monitor, cached, served over HTTP, included in `/api/state`, read by Aril or an MCP tool, or sent to a paired device.
4. **Start transport.** [Tasks: Starting a session](../architecture/tasks.md#starting-a-session) replaces the external window with the embedded transport, adds the resume path, and the Boundaries table gains rows for the host pipe, the terminal IPC channels, the history read, and the resume.

## Architecture

The history read and its live updates reuse the observation pipeline instead of adding a second one.

- **Trigger.** A new owner message or reply already moves the session's activity revision, and the shared SSE stream (`/api/events`) already carries that revision. A visible read-only Terminal tab reads again when its session's revision moves. There is no new watcher, poll, timer, or push channel, and the SSE payload stays domain, session ID, and revision.
- **Read.** The provider contract gains one optional operation, `readSessionMessages(localId, cursor, limit)`, beside `readSessionHistory`. It reuses discovery, the incremental JSONL ingestor and its source fingerprint, and the same record classifier that today checks that a reply exists and drops it. A cursor that no longer matches the fingerprint reads again from the start. Older pages reuse the history replay reader.
- **Path.** Renderer, then the IPC channel `pomegr:session-history` behind the trusted main-frame check, then desktop main, then `POST /internal/sessions/history-read` behind the existing private-action gate, then the adapter. It copies the task-feature pattern. The text passes through desktop main because the dashboard's Next server listens on every interface and must never serve conversation text.
- **Nothing stored.** The evidence schema, checkpoints, SQLite history, domain store, GET routes, SSE payload, and the LAN gateway stay text-free.
- **Check before code.** Confirm, for each provider, that a new owner message and a new reply each move a domain revision. If one does not, extend that domain rather than add an event.

## Read-only history

- The Terminal tab of any session that is not live in Pomegr's host shows its saved history, read-only, in the same terminal surface and monospace look. It is Pomegr's rendering of the saved messages, not a replay of the CLI's screen.
- Desktop app only, decided at first render like the other desktop-only actions.
- Present for any session whose provider file still exists, whether it ran in Pomegr, in an external window, or by hand.
- It has no caret. The docked input area becomes one quiet bar that names the reason it is read-only: the session ended, with its exit code and **Continue**; it runs outside Pomegr, with **Refresh** and no **Continue**; or Continue is unavailable, with the reason.
- It reads when the tab opens. While the tab is visible, it updates automatically for a session that is still running elsewhere: when the session's observed revision changes, it fetches only the new messages (owner, 2026-10-24). It reuses the observation that already watches session files and adds no watcher of its own. Nothing is read while the tab is hidden or the window is minimized. **Refresh** stays as a fallback.
- It updates message by message, as the provider saves each one, never keystroke by keystroke. The live screen of a session outside Pomegr (its spinner, partial output, and input box) stays with the terminal that runs it.
- The view goes back only as far as the provider keeps its files. When the history is missing or was compacted, the tab says so, and it never implies that Pomegr kept a copy. It promises no retention period.
- Each provider adapter gains a history read in `server/providers/provider-contract.mjs`. The shape is the same for every provider.

## Continue

- An ended session shows **Continue** in its read-only terminal's bar. Continue asks for the native confirmation, then starts the provider's own resume in the host, in the session's working directory: `claude --resume <session id>` or `codex resume <session id>`.
- It is its own validated operation in desktop main. It shares the launch helpers of the start path, but it mints no dispatch token, because the session keeps its identity and its task binding.
- The session ID is validated against the provider's ID format and travels as an argument, never inside a command string.
- Continue is refused, with a fixed reason, when:
  - the session is live anywhere, or its liveness is unknown (Codex can report `unknown` with `writer_released`; that is not permission to resume);
  - the working directory or worktree is missing or replaced;
  - the history is unavailable;
  - the provider version or the session's configuration does not support resume.

  Pomegr never falls back to the repository root, never forks the session, and never starts a replacement.
- Pomegr serializes its own resume attempts. It never replays a permission-bypass flag from the original launch.
- After the launch, Pomegr verifies that the resumed session has the same identity and task, and only then turns the same surface live. The CLI redraws its own history.
- Claude Code's `--resume` can attach to a running background session, and two foreground resumes can interleave messages. A check before the launch cannot remove that race, so a resume protection that holds for each provider and version is a release gate for Continue.

## Terminal host

The host is a small Node process that owns the ConPTY sessions. Desktop main starts it detached, so it outlives the app.

- **Runtime copy.** The host runs from a copy under the user's app data folder, one folder per app build, holding its executable, its script, and the native PTY files. An update never overwrites a folder that a running host uses, so an NSIS install does not fail on locked files.
- **Versions.** Desktop main and the host exchange a protocol version first. When they match, desktop main reconnects. When they do not, the old host keeps its sessions running, the app shows them as temporarily inaccessible, and new starts use a new host. The old host exits when its last session ends.
- **Channel.** A named pipe that only the current user's account can open. A random token for each host is kept in a file that only the user can read. The token never appears in arguments or logs, and the host authenticates a client before it lists or attaches anything.
- **Commands.** The host accepts only: create (from a start or resume plan that desktop main validated), list, attach, input, resize, and detach. It has no kill command. Its input path has one writer, the owner's IPC, but it is a single checked channel, so a later policy could add another writer.
- **Bounds.** Fixed caps on message size, scrollback for each session, total host memory, and the number of sessions. Output uses flow control. A slow or disconnected renderer never blocks the provider process: the host drops the oldest scrollback first.
- **Exit.** The host exits by itself only when it has no live process and no client for 60 seconds. Pomegr never kills a host that has a live session.

## Start path

- `task-dispatch.mjs` keeps everything up to the launch: the native confirmation, the start plan, its validation, the worktree, `POMEGR_TASK_TOKEN`, and the rollback on failure. Only the launch transport changes.
- The embedded launch passes the same executable, argument array, and directory to the host's create command. Task text still never enters a command line or a path.
- The terminal binds to the session only after the session's first report binds its dispatch token (see [Session binding](../architecture/tasks.md#session-binding)). A PTY that exists does not prove a session.
- Before that binding, a manual start shows the terminal in a start view of the task, with "Waiting for the session to report". Once the session binds, the view moves to the session's Terminal tab.
- When a launch fails and it is certain that no session started, the app offers a retry in the terminal. When the result is ambiguous, it never retries, because that could start the work twice.
- A queued start never takes focus or opens the Terminal tab. The session simply has a Terminal tab when the owner opens it.

## Terminal tab

- Desktop app only, decided at first render like the other desktop-only actions.
- The tab renders the stream with a terminal emulator in the renderer and sends keys, paste, and resize back through fixed IPC channels.
- Where the CLI's input box sits is drawn by each CLI, so the spike checks whether Claude Code and Codex keep it at the bottom of the terminal's rows, and records any gap.
- States: starting, before binding; live; reconnecting after an app restart; host unavailable (the session may still run, but reconnection is unavailable); incompatible host version (the session runs, temporarily inaccessible).
- Entry points: the session page, reached from the task card's existing **Open session** action, which opens the session as today; the owner then picks the Terminal tab (owner, 2026-10-24). The task card gets no terminal action. Later the inbox opens it too, with the same **Open session** action for an existing session, beside **Take over**, which starts a new session from a brief after the start confirmation (G14).
- A design page in `docs/internal/design/` and `/design-system` samples cover each state of both tabs.

## Failure behavior

| Case | Behavior |
| --- | --- |
| The app quits or crashes | Sessions keep running in the host. The next app start reconnects and shows the scrollback that the host still holds. |
| An update installs | The new app uses a new host folder. Sessions of a compatible host reconnect; others stay running and show as temporarily inaccessible. |
| The host cannot be reached | The Terminal tab shows "Reconnection unavailable". Observation and the read-only history continue. |
| The renderer is slow or gone | Output keeps flowing to the host's bounded scrollback. The provider never waits for the view. |
| The computer restarts | The host and its sessions end. Each session's Terminal tab turns read-only, with **Continue**. |
| The provider deleted the history | The Terminal tab says the history is unavailable, and Continue is refused. |

## Work and verification

- [ ] **Phase 1, read-only history.** The history privacy change, the adapter read for Claude Code and Codex, the internal POST route, desktop main's IPC, and the Terminal tab in its read-only mode. It needs no native module. Tests use synthetic transcripts only, and check that no tool argument, tool result, or reasoning crosses.
- [ ] **Phase 0, spike (gate for phases 2 to 6).** A throwaway branch that merges nothing. Proves, in a packaged build on Windows:
  - a detached host with ConPTY runs Claude Code and Codex with correct rendering, resize, paste, Ctrl+C, and Unicode, and where each CLI draws its input box;
  - sessions survive app quit, app crash, a packaged update, and a protocol mismatch;
  - the native module unpacks, is signed, and passes artifact inspection and legal notices (`desktop/packaging/asar-policy.mjs`, `artifact-policy.mjs`, `legal-notices.mjs`);
  - the updater path (`desktop/runtime/updater.mjs` `quitAndInstall`) does not wait for or kill the host;
  - each provider's resume either refuses a session that is already running or can be made to.

  Any live provider run in the spike follows the probe rules in `AGENTS.md`. If the spike fails, the external window stays, the terminal and Continue are cancelled or reshaped, and the read-only history stands alone.
- [ ] **Phase 2, contracts.** The control and terminal privacy changes, with the owner's decision recorded in the [purpose roadmap](purpose-roadmap.md).
- [ ] **Phase 3, host.** The host, its runtime copy, pipe, token, commands, bounds, and idle exit. Tests use a fake PTY and synthetic output only.
- [ ] **Phase 4, start path.** The embedded transport, binding to the confirmed session, and no retry after an ambiguous launch. Tests cover the launch and the rollback.
- [ ] **Phase 5, Terminal tab.** The tab, its states, the task card action, the design page, and the samples. A packaged smoke check opens a synthetic session's terminal.
- [ ] **Phase 6, Continue.** The resume operation, its refusals, the identity check after launch, and the resume protection for each provider. Tests use a fake provider.
- [ ] **Phase 7, acceptance.** The owner runs real tasks for a week, through at least one update, continues at least one ended session, and records any lost session.

## Later directions

Not part of this plan. Each needs the owner's decision and its own plan.

- **Ending stale sessions.** The host knows which process belongs to which session and task, so closeout reconciliation (G17) can show, for each task, its pull request, its session, and its terminal. An owner-confirmed **End session** for a session in the host, for example after its pull request merges, would reverse G17's rule that Pomegr never closes a session. It would never be automatic, never apply to a process outside the host, and treat "stale" as a hint, never a verdict. It belongs to the closeout debrief.
- **Sessions that talk to each other, managed by Aril.** This is the deferred idea of managed messages to a running session. It needs rules for who may write to which session, the owner's confirmation, and a record of each message, and it changes Aril's rule that it only proposes. The host's single input channel is where such a policy would apply.

## Mockup

The design review produced an interactive mockup with synthetic data that steps through every state of the Terminal tab and of Continue. It lives outside the repository until the owner accepts the design; phases 1 and 5 turn it into `/design-system` samples.

## Continuation checkpoint

2026-10-24: design converged in review. The owner then dropped the session switcher, the terminal list, and external windows, docked the CLI input, removed the focus ring, and asked to read and continue any session; reading and Continue joined the plan. The owner then folded the reading into the Terminal tab as a read-only mode, and the mockup covers it. Next action: the owner decides on the boundary changes, the placement, and the spike.
