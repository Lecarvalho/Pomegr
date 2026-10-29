# Desktop settings and diagnostics privacy

> Scope: what desktop settings, native actions, the provider-folder read, pipeline diagnostics, and repository context inventories may hold or expose.
> Authority: canonical privacy invariants for this subject. Behavior detail is in [Observation cache](../observation-cache.md) and [Pipeline operations](../../operations/pipeline-diagnostics.md).
> A change that widens exposure changes this page in the same pull request.

## Provider-folder settings

- Desktop provider-folder settings are explicit native actions.
- Persist only three bounded absolute folder overrides in private desktop settings:
  Claude configuration, Claude session projects, and Codex home.
- Renderer IPC accepts only fixed folder keys.
- Renderer IPC returns bounded selection/availability/action states, never paths.
- Native folder selection and save/restart confirmation own the actual paths.
- Browser/LAN APIs cannot configure sources.
- Apply one coherent profile to discovery, presence, tasks, account usage, and native
  provider setup.
- Preserve checkpoint source validation.
- Isolate default local usage/cost snapshots for custom Claude profiles.

Behavior: [Observation cache](../observation-cache.md)

## Storage settings

- Desktop storage settings may persist only `retentionDays` (30/90/180/365/keep-all) and
  `storeMaxMb` (250/500/1024/2048).
- Each setting is null or a fixed choice.
- The settings change only through trusted-main-frame fixed-key IPC and a native
  save/restart confirmation.
- The monitor applies them only at its next start and prune cycle, never from IPC or a GET.
- Browser and LAN clients read storage readiness only.

Behavior: [Observation cache](../observation-cache.md)

## Phone access

- Native phone-access state may expose the fixed `network_probe_timed_out` reason for a Windows network probe timeout.
- Process errors and network probe output remain private and never reach renderer state or logs.

Behavior: [Local monitor](../overview.md#local-monitor)

## Home announcement markers

- Desktop Home announcement markers may persist only `homeUpdate.seenId` and
  `homeUpdate.dismissedId`.
- They live in private desktop settings.
- Each marker is null or one bounded announcement identifier: lowercase letters, digits,
  and hyphens, at most 64 characters.
- They change only through a trusted-main-frame fixed-key IPC channel.
- They record only that the What's new dialog opened once and that the card was dismissed.
- They never hold a path, session identifier, or user content.

Behavior: [Observation cache](../observation-cache.md)

## Session window focus

**Trigger:** only a click on a native `needs_input` notification, after Pomegr has opened
that session. No browser, LAN, or IPC route can request it.

**Owner lookup:**

- The desktop main process asks the monitor worker over its private message channel for
  the session's owning process.
- The monitor answers from its latest live inspection only, with a pid, a process start
  identity, and at most two window titles. It answers null for a session that is not live,
  has no owner, or shares its owner with another session.
- The window titles are the titles the session's terminal may show. For Claude Code they
  are the transcript's custom title and AI title, one line each, at most 512 characters.
  Other providers send none.
- The owner and its titles are kept in monitor memory only. They never enter a response, a
  log, a store, or renderer IPC.

**Helper:**

- One fixed hidden Windows PowerShell helper runs with an argument array. It receives the
  pid, the start identity, Pomegr's own pid, and at most three titles (the monitor's
  window titles and the notification title) on stdin, never on its command line.
- The helper reads only the process list, the top-level window list and titles, and which
  `conhost.exe`, `OpenConsole.exe`, or `WindowsTerminal.exe` processes hold a handle to the
  session's process. It confirms the process start identity first.
- It answers one fixed word (`focused`, `refused`, `ambiguous`, `missing`, or
  `unavailable`). Pomegr keeps no answer.

**Which window qualifies:**

- A window of a console host that holds a handle to the session's process.
- Else, a window of a terminal that holds that handle. When the terminal has several
  windows, only the one window whose title contains one of the session's titles qualifies.
- Else, a window of the session's nearest ancestor process that owns windows. The walk
  stops at Pomegr itself and at shell and service processes such as `explorer.exe` and
  `svchost.exe`.
- More than one qualifying window, or none, focuses nothing.

**Never:** the helper sends no input, attaches to no process or console, and changes no
window except to restore and bring forward the one qualifying window. It does not run off
Windows.

## Terminal output

- Only a saved-history Markdown link the owner clicks reaches `pomegr:open-session-link` through the desktop `openSessionLink` bridge.
- The channel accepts exactly one string from the trusted main frame: a canonical HTTPS URL with no username or password and at most 2048 characters (`new URL(value).href === value`).
- Desktop main revalidates the URL and calls `shell.openExternal`; it returns only `{ ok: true }` or `{ ok: false, error: "invalid" }`.
- The URL is not stored or logged, and the channel never navigates the window or reaches a browser, paired device, monitor, Aril, or MCP route.
- Ordinary navigation and window-open handling retain the fixed external-URL allowlist, including middle-click.

- Owner-confirmed Continue uses the [Continue plan](session-evidence.md#continue-plan) in desktop main only; its folder appears only in native confirmation.
- Continue IPC returns only a fixed status, never a plan, working folder, title, executable, arguments, or environment.
- Main sends a live host PID through private worker messages to resolve its unique committed session identity.
- The monitor returns only that qualified session ID or null; the PID never reaches the renderer or HTTP.
- Terminal listings may include `continuedFrom`, the qualified original session ID, beside the currently observed `sessionId` to identify a provider replacement.
- Task terminal listings carry `role: "build" | "review"`, the repository and task IDs, and the corresponding bound session ID; review identity comes only from the desktop-token [review-session read](../tasks.md#boundaries), never the builder link.
- Continue mappings stay in memory and rebuild from host keys; no mapping or plan is persisted.

- Terminal output flows only from the desktop-owned terminal host, through desktop main,
  to the trusted desktop renderer that attached to that session.
- The host keeps the normal and alternate terminal screens and up to 5000 scrollback lines per running session in memory only.
- Attach sends at most 4 MiB of serialized screen state, omitting oldest scrollback lines when needed.
- If the screens alone exceed the replay cap, attach returns `TERMINAL_CAPACITY` without exposing a partial snapshot.
- Exit clears and disposes the retained screen; its exit code remains listed until acknowledgement or host shutdown.
- Terminal output is never written to disk, logged, sent to the monitor, cached, served
  over HTTP, or included in `/api/state`.
- Terminal output never reaches Aril, an MCP tool, a paired device, or another renderer.
- The terminal host accepts input only from the owner's trusted desktop renderer. It has
  no agent, queue, MCP, or monitor command.
- The host's `end` command, which ends one terminal's process tree, is sent by desktop main
  alone, with the host token, and only for a Done task's session. The Tasks interface asks
  desktop main through `pomegr:task-sessions`, which carries a repository ID, a task ID, and
  fixed words in and counts or a fixed status out; no key, process ID, or terminal text
  crosses it. Main ends a session only when the monitor lists its task as Done. See
  [Ending a Done task's sessions](../tasks.md#ending-a-done-tasks-sessions).

## Provider-folder read

**Access** (as explicitly approved by the user):

- Read-only **Settings → Providers** may display the three effective provider folder roots.
- It can do this in a same-computer browser or in an authenticated paired LAN browser.
- It uses the dedicated no-store `GET /api/provider-folders`.

**Return only:** bounded absolute Claude configuration, Claude session projects, and
Codex home roots, or null.

**This exception excludes:** transcript-file paths, credentials, ordinary normalized state,
reports, logs, checkpoints, and browser persistence.

**Access rules:**

- Local development access requires an actual local socket peer and a recognized machine
  hostname or interface address.
- Forwarded headers cannot authorize it.
- LAN gateway forwarding requires current pairing and network authorization.
- Deny unpaired remote access, cross-origin requests, writes, and path inputs.
- Serve startup configuration without provider acquisition.
- Folder changes remain native actions.

## Claude Code reconnection and local usage setup

- Desktop Claude Code reconnection and local usage setup are explicit user-confirmed native
  actions, outside monitor GETs.
- Reconnection invokes only the installed native CLI's sign-in flow.
- Reconnection never reads, refreshes, collects, or forwards credentials.
- Local usage setup changes only the user's status-line configuration, after native
  confirmation.
- Local usage setup preserves the existing configured command.
- Neither action is exposed through HTTP.
- Neither action accepts commands, paths, or URLs from the renderer.

## Pipeline diagnostics

**Scope:** internal pipeline-operations diagnostics remain read-only, bounded, and outside
browser API state.

**Writer:**

- In normal development, startup creates one anonymous continuous JSONL writer before
  observation begins.
- The writer owns only `outputs/pipeline-logs/` files.
- It retains at most ten 25 MiB files (250 MiB default).
- It has a 1 MiB queued-record limit.
- It has a separately bounded in-flight batch of at most 1 MiB.
- It assumes one development writer.

**Records use only:**

- the fixed normalized operations vocabulary;
- a fresh per-run UUID;
- timestamps;
- synthetic lanes;
- opaque numeric handles.

**Records must never contain:** session IDs, source paths or fingerprints, prompts,
responses, transcript/tool content, credentials, or raw errors.

**Owner-probe outcomes:** the operations snapshot, and so the `health` record, holds
the fixed `ownerProbe` counters of each provider. They are counts of check outcomes
only. They must never contain a process ID, a process-start identity, a process name, a
command, a path, a session ID, helper output, or an error.

**Coverage:**

- Explicit gap, loss, lifecycle, health, incomplete-span, and observed-coverage semantics
  prevent retention or absence from being presented as complete session history.

**Analyzers:**

- `npm run diagnostics:logs -- ...` and the compatibility alias
  `npm run diagnostics:analyze -- ...` are passive file-first analyzers/followers.
- They never connect to the monitor.
- They never trigger pipeline work.

**Sole path:**

- Continuous JSONL is the sole diagnostics path.
- No capture IPC, renderer instrumentation, export, viewer, or optional trace mode remains.
- GETs and production/desktop artifacts exclude continuous logging.

Behavior: [Pipeline operations](../../operations/pipeline-diagnostics.md)

## Repository context inventories

**Capture:**

- Repository context inventories are repository/provider-scoped diagnostics.
- They are captured only through an explicit trusted desktop action.
- No browser route may trigger capture.
- Browser and LAN GETs serve committed normalized revisions only.

**Monitor-private:** repository roots, commands, executables, raw output, stderr, errors,
credentials, and private fingerprints. They must not enter renderer IPC, browser state,
logs, or persistence.

**Session references:**

- A session reference binds once, only for future sessions.
- It binds to a revision already committed when the session started.
- In-session provider evidence takes precedence.
- Absent evidence renders no `/context` instruction.
