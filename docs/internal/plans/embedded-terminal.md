# Sessions inside Pomegr: terminal, history, and continue

> Status: active; the owner accepted the plan and its architecture on 2026-10-24. Phase 0 (the spike) ran, phase 1 (read-only history) shipped, and phases 2 through 6 are built.
> Created: 2026-10-24.
> Scope: keep the owner's coding-agent sessions inside the desktop app. Sessions that Pomegr starts run in a Terminal tab of the session, through a desktop-owned terminal host that survives app restarts and updates. The same Terminal tab shows any other session's saved history read-only, and an ended session can be continued in it through the provider's own resume. It covers the boundary changes, the host, the start and resume paths, the Terminal tab, and the feasibility spike that gates the terminal. The takeover brief (G14) and the owner inbox (G13) stay in the [purpose roadmap](purpose-roadmap.md); this plan gives them a place to open a session.
> Continuation owner: the product owner decides; the agent that picks up a phase records its evidence in the checkpoint.
> Authority: working plan. `AGENTS.md`, [Tasks](../architecture/tasks.md), [session evidence privacy](../architecture/privacy/session-evidence.md), and [desktop privacy](../architecture/privacy/desktop-and-diagnostics.md) govern shipped behavior until each phase changes them.
> Next task or decision: phase 6 Continue is built. Phase 7 acceptance remains open.
> Completion criteria: the read-only history ships; the spike passes or the terminal part is cancelled; when it passes, a session started from Pomegr opens in its Terminal tab, survives app quit, crash, and update, an ended session continues in the terminal, and every rule below has a test.
> Permanent destinations: `AGENTS.md` for the control boundary, [Tasks](../architecture/tasks.md) for the start and resume paths and the host boundary, [session evidence privacy](../architecture/privacy/session-evidence.md) for the history read, [desktop privacy](../architecture/privacy/desktop-and-diagnostics.md) for terminal output, the provider contract for the history read, a page in `docs/internal/design/` for the Terminal tab, and `/design-system` for its states.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Summary

Before the embedded terminal work, the desktop app started each task session in a separate terminal window (`desktop/runtime/task-dispatch.mjs`, one fixed `Start-Process` command).
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
| Host runtime | A Node runtime bundled with Pomegr runs the terminal host, copied per build with the native PTY module; not the user's Node, which Claude Code's native installer and Codex's standalone binary do not need, and not Electron's executable, whose per-build copy is about 200 MB (owner, 2026-10-24). |
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

1. **Control.** `AGENTS.md` says that dispatch never stops or attaches to a session Pomegr did not start, answers work, or approves work in a running session. The desktop app lets the owner type and paste into a session Pomegr started in its terminal host. It does not let an agent, Aril, queue, MCP tool, or monitor send input or end a session. Continue is the second owner-confirmed control action, for ended sessions only.

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
4. **Start transport.** [Tasks: Starting a session](../architecture/tasks.md#starting-a-session) replaces the external window with the embedded transport. The Boundaries table lists the terminal IPC channels and the host's private pipe.

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

## Continue (phase 6)

- An ended session shows **Continue** in its read-only terminal's bar. Continue asks for the native confirmation, then starts the provider's own resume in the host, in the session's working directory: `claude --resume <session id>` or `codex resume <session id>`.
- It is its own validated operation in desktop main. It shares the launch helpers of the start path, but it mints no dispatch token, because the session keeps its identity and its task binding.
- The session ID is validated against the provider's ID format and travels as an argument, never inside a command string.
- Continue is refused, with a fixed reason, when:
  - the session is live anywhere, or its liveness is unknown (Codex can report `unknown` with `writer_released`; that is not permission to resume);
  - the working directory or worktree is missing or replaced;
  - the history is unavailable;
  - the provider executable is missing;
  - a resume of the session is already starting or running in the host.

  Pomegr never falls back to the repository root, never forks the session, and never starts a replacement.
- Pomegr serializes its own resume attempts. It never replays a permission-bypass flag from the original launch.
- After launch, the same tab attaches to the host key. The CLI redraws its own history; the existing task link is unchanged.
- A different committed process identity shows **This session continued as a new session.** with a link; Pomegr never claims the original identity.
- Accepted residual risk, 2026-10-24: Claude Code can resume a background session, and two foreground resumes can interleave messages. Pomegr's checks cannot eliminate a simultaneous external-start race.

## Terminal host

The host is a small Node process that owns the ConPTY sessions. Desktop main starts it detached, so it outlives the app.

- **Runtime copy.** The host runs on bundled Windows x64 Node 24.14.0 LTS, acquired from nodejs.org during packaging and checked against a repository-pinned SHA-256. Its license ships with the resource. Desktop main verifies every file against the package-time manifest before using `terminal-host/<build id>/` under user data; the build ID hashes the manifest's file inventory. A startup lock serializes preparation and launch. A damaged inactive copy is rebuilt, but a running host's folder is never replaced.
- **Versions.** Desktop main and the host exchange a protocol version first. When they match, desktop main reconnects. When they do not, the old host keeps its sessions running, the app shows them as temporarily inaccessible, and new starts use a new host. The old host exits when its last session ends.
- **Channel.** Protocol 1 uses a Windows named pipe through `node:net`, with length-prefixed JSON. Before any reply or command, the client must send `hello` with the matching protocol and the 256-bit token within two seconds; comparison is constant-time. The state and token files inherit a protected current-user-only directory DACL. The pipe itself relies on the token, like the monitor's desktop gate: this phase ships no native DACL helper. A protected pipe DACL would additionally prevent other local accounts from opening the pipe or occupying unauthenticated slots.
- **Commands.** The host accepts only hello, create (from a plan desktop main validated), list, attach, input, resize, and detach. Create rechecks absolute paths, argument and environment bounds, an environment allowlist, dimensions, and an opaque key before `node-pty` 1.1.0 spawns with `useConptyDll: true`. There is no kill or signal command. One attached client owns input; a second attaches read-only. A detach may acknowledge an exited session and remove its record.
- **Bounds.** There are at most 16 sessions, eight connections, and four unauthenticated connections. JSON frames are capped at 64 KiB and input frames at 16 KiB. Each running session keeps a headless terminal with 5000 scrollback lines. Attach serializes its screens, cursor, and modes in 4096-character frames, capped at 4 MiB by omitting oldest scrollback lines; screens that exceed the cap without scrollback refuse attach with `TERMINAL_CAPACITY`. Slow clients detach with a fixed reason; the PTY keeps running. Exit drops scrollback but retains the exit code until acknowledged or the host exits.
- **Exit.** The host exits by itself only when it has no live process and no client for 60 seconds. Pomegr never kills a host that has a live session.
- **Startup and restart.** Desktop main restricts the runtime parent once per app process before preparing any copy; build folders and state inherit its user-only ACL. The host does not launch PowerShell. It retries a busy pipe for at most one second before failing, and atomically replaces token and state only after binding. The client observes spawn errors and early exits, accepts replacement state only for the PID it spawned, and retains the 15-second startup deadline.

## Start path

- `task-dispatch.mjs` keeps everything up to the launch: the native confirmation, the start plan, its validation, the worktree, `POMEGR_TASK_TOKEN`, and the rollback on failure. Only the launch transport changes.
- The embedded launch passes the same executable, argument array, and directory to the host's create command. Task text still never enters a command line or a path.
- The terminal binds to the session only after the session's first report binds its dispatch token (see [Session binding](../architecture/tasks.md#session-binding)). A PTY that exists does not prove a session.
- Before that binding, a manual start shows the terminal in a start view of the task, with "Waiting for the session to report". Once the session binds, the view moves to the session's Terminal tab.
- When a launch fails and it is certain that no session started, the app offers a retry in the terminal. When the result is ambiguous, it never retries, because that could start the work twice.
- A queued start never takes focus or opens the Terminal tab. The session simply has a Terminal tab when the owner opens it.

## Terminal tab

- The read-only history renders owner and agent text through the shared safe Markdown renderer (owner, 2026-10-24).
- Desktop app only, decided at first render like the other desktop-only actions.
- The tab renders the stream with a terminal emulator in the renderer and sends keys, paste, and resize back through fixed IPC channels.
- Where the CLI's input box sits is drawn by each CLI, so the spike checks whether Claude Code and Codex keep it at the bottom of the terminal's rows, and records any gap.
- States: **Waiting for the session to report** before binding; live; reconnecting after an app restart; unavailable with **Reconnection unavailable. The session may still be running.**; and an incompatible host with **This session runs in an older host and is temporarily inaccessible.** Input stays disabled until the terminal attaches.
- Entry points: a manual start opens the task's Terminal start view. Binding opens the session's Terminal tab. An unbound task card links to that start view as **Waiting in terminal**. A queued start never navigates. The inbox entry remains future G14 work.
- A design page in `docs/internal/design/` and `/design-system` samples cover each state of both tabs.

## Failure behavior

| Case | Behavior |
| --- | --- |
| The app quits or crashes | Sessions keep running in the host. The next app start reconnects and shows the scrollback that the host still holds. |
| An update installs | The new app uses a new host folder. Sessions of a compatible host reconnect; others stay running and show as temporarily inaccessible. |
| The host cannot be reached | The Terminal tab shows "Reconnection unavailable. The session may still be running." Input stays disabled. |
| The renderer is slow or gone | Output keeps flowing to the host's bounded scrollback. The provider never waits for the view. |
| The computer restarts | The host and its sessions end. Each session's Terminal tab turns read-only, with **Continue**. |
| The provider deleted the history | The Terminal tab says the history is unavailable, and Continue is refused. |

## Work and verification

- [x] **Phase 1, read-only history.** Shipped in #284 (monitor read) and the Terminal tab change (desktop bridge and tab).
- [x] **Phase 0, spike (gate for phases 2 to 6).** Ran on 2026-10-24 on a throwaway branch with a fake CLI; findings are in the checkpoint.
  - a detached host with ConPTY runs Claude Code and Codex with correct rendering, resize, paste, Ctrl+C, and Unicode, and where each CLI draws its input box;
  - sessions survive app quit, app crash, a packaged update, and a protocol mismatch;
  - the native module unpacks, is signed, and passes artifact inspection and legal notices (`desktop/packaging/asar-policy.mjs`, `artifact-policy.mjs`, `legal-notices.mjs`);
  - the updater path (`desktop/runtime/updater.mjs` `quitAndInstall`) does not wait for or kill the host;
  - each provider's resume either refuses a session that is already running or can be made to.

  Any live provider run in the spike follows the probe rules in `AGENTS.md`. If the spike fails, the external window stays, the terminal and Continue are cancelled or reshaped, and the read-only history stands alone.
- [x] **Phase 2, contracts.** The control and terminal privacy contracts define owner-only terminal input and keep terminal output out of persistent and network surfaces.
- [x] **Phase 3, host.** The host, its runtime copy, pipe, token, commands, bounds, and idle exit. Tests use a fake PTY and synthetic output only.
- [x] **Phase 4, start path.** The embedded transport keeps the confirmed executable, argument array, and working directory. Binding waits for the session link, rollback and status remain fixed, and ambiguous launch results are never retried.
- [x] **Phase 5, Terminal tab.** The live Terminal tab, task start view, binding and host states, task-card link, design contract, and synthetic samples are built.
- [x] **Phase 6, Continue.** The private monitor plan, native confirmation, serialized resume, refusals, restart binding, and observed identity replacement are built. Tests use synthetic providers.
- [ ] **Phase 7, acceptance.** The owner runs real tasks for a week, through at least one update, continues at least one ended session, and records any lost session.

## Later directions

Not part of this plan. Each needs the owner's decision and its own plan.

- **Ending stale sessions.** The host knows which process belongs to which session and task, so closeout reconciliation (G17) can show, for each task, its pull request, its session, and its terminal. An owner-confirmed **End session** for a session in the host, for example after its pull request merges, would reverse G17's rule that Pomegr never closes a session. It would never be automatic, never apply to a process outside the host, and treat "stale" as a hint, never a verdict. It belongs to the closeout debrief.
- **Sessions that talk to each other, managed by Aril.** This is the deferred idea of managed messages to a running session. It needs rules for who may write to which session, the owner's confirmation, and a record of each message, and it changes Aril's rule that it only proposes. The host's single input channel is where such a policy would apply.

## Mockup

The design review produced an interactive mockup with synthetic data that steps through every state of the Terminal tab and of Continue. Its states have synthetic `/design-system` samples; phase 6 implements the Continue states.

## Continuation checkpoint

2026-10-25, terminal screen replay: the host keeps a headless screen and 5000 scrollback lines per running session, with normal and active alternate buffers and modes. A queued write callback serializes after prior output parses; subsequent write callbacks fan out after replay, without missing or duplicating chunks. Replay is capped at 4 MiB, and client and renderer replay budgets are separate from live-output limits. Exit still clears output and now disposes the screen. The immutable runtime includes both Xterm packages and MIT notices; protocol 1 is unchanged. Synthetic coverage includes a 10000-line fake CLI, inline cursor moves, alternate-screen transitions, resize, attach ordering, the cap, and slow consumers. Phase 7 acceptance remains open.

2026-10-24, live terminal typography: xterm uses line height 1.4 and the computed data font, with the same responsive inset as saved history. Font loading waits at most 500 ms before opening; a later load refits the terminal and resizes the host. Theme colors remain on the existing command tokens.

2026-10-24, live terminal replay fix: attach batches retained scrollback into bounded frames without splitting surrogate pairs. The client budgets replay without rejecting it before the attach answer. Desktop main preserves the fixed replay marker. The panel suppresses replay-generated query answers and waits for replay parsing before enabling input. A detached view stays unavailable after a late attach answer. Phase 3 shipped in #287; its checkbox is now checked. Phase 7 acceptance remains open.

2026-10-24, phase 6: Continue now uses a desktop-only monitor plan and the provider's native resume in the terminal host. Main validates the plan, confirms with Cancel as default, and rechecks before launch. No dispatch token, model, effort, or permission flag is replayed. Host keys reconstruct mappings after restart; committed process ownership identifies a replacement session. The added monitor route keeps cwd out of public projections and renderer IPC. Synthetic tests cover refusals, cancellation, serialization, mapping, and replacement identity. Known residual risk: Claude Code can resume a background session, and simultaneous foreground resumes can interleave; an external start can race Pomegr's checks. Phase 7 remains open.

2026-10-24: the owner tried the read-only tab on a live session; text now renders formatted; the host runtime is a bundled Node.

2026-10-24: design converged in review. The owner then dropped the session switcher, the terminal list, and external windows, docked the CLI input, removed the focus ring, and asked to read and continue any session; reading and Continue joined the plan. The owner then folded the reading into the Terminal tab as a read-only mode, and the mockup covers it. Later the same day the owner approved the architecture and the plan, and asked to start phase 1 and phase 0 now, alongside 0.9.0. Next action: phase 1 server half.

2026-10-24, later: phase 1 shipped. The monitor reads a session's history from byte cursors through the existing incremental reader, and the desktop app shows it in a read-only Terminal tab that reads again on the existing `session-summary` revision while visible. Phase 0 ran with a fake CLI:
- Passed: a detached host kept sessions running through a normal parent exit and a hard kill, with reconnection and input; a run from a per-build copy survived an overwrite of the installed folder, while a run from the installed folder hit a sharing error; a protocol mismatch refused to attach and left the session running; resize, a 10 KB paste, and Ctrl+C reached the child; the host exited 60 s after going idle and never while a session lived.
- Partial: `node-pty` 1.1.0 prebuilds ran under Node and Electron and inside the packaged asar, but a source build was not proved (no Python on the build machine).
- For the product phases: choose how the host's executable ships (the app ships no plain `node.exe`), decide between a reproducible native build and verified prebuilds, harden the user-only pipe transport, run the real Electron updater path, and run an attended check of the real Claude Code and Codex CLIs in the host, including how each draws its input box and whether each resume refuses a running session.

Next action: the owner reviews the spike findings and decides how the host executable ships; then phase 2.

2026-10-24, phase 3: implemented the standalone host and desktop-main client without a caller in task dispatch, shell main, IPC, or the renderer. The package uses the spike's four ConPTY native files and verified upstream Node-API prebuilds, with a bundled, pinned Node executable and a manifest-verified immutable runtime copy. Tests cover hostile authentication, bounds, replay, input ownership, lifecycle, integrity repair, reuse, other-build discovery, and hard-kill restart with lost sessions; only synthetic PTYs and a fake CLI are used. The client's allowlisted create environment is deliberately narrower than today's external-window `userSessionEnvironment`; phase 4 must construct that environment explicitly. An exited record is acknowledged through `detach`, since the command list has no separate acknowledgement operation.

2026-10-24, phases 2, 4, and 5: the control and output privacy contracts now cover owner-only input to Pomegr-started sessions. Task dispatch uses the detached terminal host with the same executable, argument array, and working directory, plus the explicit allowlisted environment and `POMEGR_TASK_TOKEN`. The task start view waits for session binding; the key stays in memory and rebuilds from the host list and confirmed task session links (`task.session.id`). The live Terminal tab and its host states have synthetic design-system samples. Verification passed: `npm test` (3,985 Node tests and 2,404 UI tests, four Node skips), lint (57 warnings, no errors), architecture, boundaries, docs, `verify:fast`, and build. Browser visual review was blocked by computer-use approval. Restart reconstruction remains conservative when multiple live keys share one task; incompatible hosts cannot disclose keys through this protocol, so their cold-start notice cannot identify individual sessions. Neither case adds persisted binding fields.

Continuation: phases 2, 4, 5, and 6 are built. Phase 7 acceptance remains open. The owner still decides whether to add a protected pipe DACL; no helper ships here. Actual Electron updater survival, signed artifacts, attended real-provider rendering, and resume protection remain acceptance work. No owner page or privacy boundary changes in phase 3.

PR #287 restart follow-up: removed the host's redundant ACL subprocess, added bounded busy-pipe retry and early-exit detection, and bound replacement state to the spawned PID. The hard-kill regression captures synthetic-host stderr only in the test and still checks a new PID and lost sessions. Local fault injection reproduced the missing early-exit handling and immediate busy-pipe failure; the original Windows CI startup failure cannot be distinguished from the supplied timeout log alone.

Phase 3 verification: 38 focused host/client/packaging tests passed; `npm test` passed (3,968 Node tests and 2,388 UI tests, four Node skips); lint, architecture, boundaries, docs, `verify:fast`, web build, and desktop preparation passed. The standalone bundled Node and Electron ASAR both loaded the two native addons. `desktop:smoke:ci` reached monitor startup and failed with `DESKTOP_SMOKE_FAILED_MONITOR_SPAWNED_ELECTRON_EXIT_BREAKPOINT`; this is not a passed desktop acceptance gate. Node's complete redistribution license is an unavoidable 2,946-line addition beyond the approximate implementation-line budget.

An actual unsigned `electron-builder --dir` package passed application allowlisting, privacy scanning, dependency-notice parity, four-native-file and 21-module-file inventory checks, and verification of the 27-file external runtime manifest. Source, ASAR, and resource host scripts matched byte-for-byte. Electron-builder also unpacks node-pty runtime JavaScript; inspection constrains the complete module inventory and the exact four native prebuilds separately. Explicit resource mappings retain the nested modules that its default resource copier omits. No installer or signing acceptance is claimed.

