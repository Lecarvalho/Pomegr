# Agent chat

> Scope: the chat with Aril, the Pomegr task-board agent: its provider run, what it
> reads, how it proposes board changes, the saved conversations, and the two ways a
> client reaches it. It does not cover the board itself, which
> [Tasks](tasks.md) owns, or the controls and styles, which
> [Agent chat design](../design/agent-chat.md) owns.
> Authority: canonical contract for the agent chat, and canonical owner of its privacy
> invariants (the [Privacy](#privacy) section). Requested by the product owner on
> 2026-10-11 (task T-29, GitHub issue #170). The session start that a proposal may ask
> for was added on 2026-10-12 (task T-72), and the queue change on the same day (task
> T-75). The images that the owner sends, and their way to a task, were added on
> 2026-10-13 (task T-86), and the follow-up after an answered proposal on the same day
> (task T-95). Proposals of a change that Aril recommends by itself were added on
> 2026-10-15 (task T-123). Follow-up proposals with owner approval were added on
> 2026-10-17 (task T-120). Grant follow-ups were added on 2026-10-26 (task T-183). One thread for each repository, with search, was
> added on 2026-10-28 (Aril agent plan, phase 1), and so were its compaction into a summary
> and the timing of each run. Quick replies and one multiple-choice question under an answer were added on 2026-10-28
> (Aril agent plan, phase 2), and so were a smaller prompt and a "Starting" label that lasts only until the provider's first event (2026-10-29). A change that widens exposure changes the
> Privacy section in the same pull request. The executable contract
> `shared/agent-chat-contract.ts` wins on exact shapes. Repository-wide rules are in
> [AGENTS.md](../../../AGENTS.md).
> Related code and checks: routed in the
> [agent workflow](../development/agent-workflow.md).

**Status: built.** The chat panel, the provider run for Claude Code and Codex, the
proposals and their approval, the saved conversations, and the paired-device route have
shipped. The parts that are not proven on a device are listed under
[Limits and unproven parts](#limits-and-unproven-parts).

Aril is an agent that organizes one repository's task board. The owner asks in a chat
panel; Aril reads the board, the repository's files, and Pomegr's observations, and
answers. Aril may record a rework link (references and a cause from a fixed list) without Apply; it changes no task. Aril otherwise changes and starts nothing itself, except through the fixed grant actions
while a grant the owner started is active ([Aril grants](tasks.md#aril-grants)). Otherwise it
proposes board changes, and Pomegr applies a proposal after the owner presses **Apply changes**.
While an owner-started grant is active, the desktop runner may start selected Ready tasks and
their reviews, send failed work back within the grant's limit, merge on green CI after a passing
review, and write tasks from the plans the grant names, through those fixed grant actions.
When the owner asks for it, Aril
also proposes to start a session for one named task; Pomegr starts it through the manual
start of the Tasks page, only after the owner selects **Start session** on that proposal
in the desktop app
(see [Session start](#session-start)). When the owner asks for it, Aril also proposes to
turn the repository's queue on or off; Pomegr sends the Tasks page's own queue action,
only after the owner selects **Turn queue on** or **Turn queue off** on that proposal, in
the desktop app or on a paired device (see [Queue change](#queue-change)). When the owner
asks about disk space or cleanup, Aril also proposes to remove task worktrees; Pomegr removes
each only after the owner selects **Remove worktrees** on that proposal in the desktop app
(see [Worktree removal](#worktree-removal)). The owner may
send images with a message, and a proposal may put those images on a task (see
[Images](#images)). After the owner applies or dismisses a proposal, Aril writes one
follow-up about the outcome without another message of the owner (see
[Follow-up](#follow-up)). While a grant works, Pomegr also writes short grant follow-ups into
the chat, with no provider run (see [Grant follow-ups](#grant-follow-ups)). The owner sees each repository as one continuous
conversation with search, not as a list of conversations (see [The thread](#the-thread)). When a thread
outgrows what a prompt carries, Pomegr summarizes its older part in the background and keeps the summary
for Aril's later runs; the owner still sees and searches every message (see [Compaction](#compaction)). Aril talks briefly: it may end
an answer with quick replies or one multiple-choice question, and a tap sends its label as the owner's own message and does nothing else (see
[Choices](#choices)). The user guide is
[Agent chat](../../public/using-pomegr/agent-chat.md).

## Ownership

Desktop main owns the whole chat. The monitor does not know that the chat exists: it
serves the board and takes the fixed task actions as it does for the Tasks page. The one
thing it holds for the chat is the session ID of a running Claude Code turn, so the
catalog leaves that run out (see [The declared run](#the-declared-run)).

| Owner | Responsibility | May not |
| --- | --- | --- |
| `desktop/runtime/agent-chat.mjs` | The operations, the one running turn, the choice of the conversation a message goes to, the follow-up after an answered proposal, the trusted IPC handler, the answers, the hand-off of an approved session start to the manual start, the one request of an approved queue change, the removal of the worktrees the owner approved, and the stop of a repository's compaction when a turn of it starts | Pass provider, monitor, or error text through; import `server/`; start a session by any path but the manual start it is given, or for a call that is not the desktop window's; remove a worktree for a call that is not the desktop window's, or by any path but the unforced removal of `task-worktree.mjs`; send `queue_settings` with any setting but `on` |
| `desktop/runtime/agent-chat-runner.mjs` | The fixed provider arguments, the process, the reading of its output, and the run's own [timing](#timing) | Put the prompt or any owner text in an argument, a path, or the environment; name an image folder or file that is not in the fixed form desktop main builds; report any content in a timing |
| `desktop/runtime/agent-chat-images.mjs` | The image files the owner sends: the staged ones and the ones of each conversation | Write outside the chat's directory; build a path from anything but a validated repository ID, conversation ID, and image ID; serve a file by itself |
| `desktop/runtime/agent-chat-prompt.mjs` | The instructions, the board snapshot, the summary of earlier conversation, the history of the thread for one turn, and the length of each part | Read anything itself |
| `desktop/runtime/agent-chat-thread.mjs` | The thread: the order of a repository's messages across its conversations, a page of them, the cursor, the conversation the next message goes to, the last run, where the summary ends, and the search of their text | Read or write a file; answer more than `read` of the same conversations answers; read a pattern from the owner's text; answer the text of a summary |
| `desktop/runtime/agent-chat-summary.mjs` | The summary of a repository's thread: its record, its file, and the view of it a client may have (a position and a time) | Write outside its directory; answer its text to a client |
| `desktop/runtime/agent-chat-compaction.mjs` | [Compaction](#compaction): when it runs, the messages it takes, its prompt, its read-only run with no tool, the check of its answer, and its stop | Run more than one for a repository, or while a turn of it runs; use a tool, a proposal, or the board; store anything but plain text; keep a partial answer |
| `desktop/runtime/agent-chat-timing.mjs` | The record of a [timing](#timing) and its bounds, the preparation's milliseconds included | Hold any text |
| `desktop/runtime/agent-chat-prepare.mjs` | The [preparation](#preparation) of a turn: the reads it needs before its process starts (board, repository root, observed runs, task log, GitHub settings, workflow changes, the cached worktree facts, instructions file, the thread's facts, and the run's environment), begun together, and the milliseconds each step took | Refuse a message; hold or time any text; read more than the reads it is given; keep anything after the turn |
| `desktop/runtime/agent-chat-worktrees.mjs` | The [facts of the task worktrees](#task-worktree-facts) that a turn reads, kept in memory between turns: the Git facts, the sizes, when the Git facts were read, their refresh in the background, and the read of every board's repository after start | Make a turn wait for any of it; keep a path, a file name, or Git output; run two refreshes for a repository at once; be read by a removal |
| `desktop/runtime/agent-chat-task-bridge.mjs` | The temporary loopback bridge through which the chat's MCP server reads a task of the turn's repository | Serve more than the two task reads; outlive its turn |
| `desktop/runtime/agent-chat-provider-files.mjs` | The fixed instructions file Claude reads and the entry of the chat's own MCP server | Hold owner, board, conversation, or credential text |
| `desktop/runtime/agent-chat-proposal.mjs` | Reading, validating, and applying a proposal | Reach the board except through the caller's task-action request and image request; read an image; start a session; change the queue |
| `desktop/runtime/agent-chat-choices.mjs` | The [choices](#choices) block: its strict reading and bounds, the text shown while an answer is written, and the line a later prompt reads | Apply, start, or change anything; read a block other than its own fence; store or send anything but the validated shape |
| `desktop/runtime/agent-chat-store.mjs` | The saved conversations, with the [timing](#timing) and the [choices](#choices) of an answer | Write outside its directory, or overwrite a file outside the contract |
| `desktop/runtime/agent-chat-workflow.mjs` | The [workflow changes](#workflow-changes) read: which workflow source files changed after the owner settled Aril's settings and memory, and the facts it keeps from Git for each root while their key is the same | Run anything but read-only `git log` and `git status` with an argument array, in the repository root, within 5 seconds; read file content; list a name outside the fixed list and the workflows folder; reuse facts whose key differs or cannot be read |
| `server/providers/kernel/chat-run-declarations.mjs` | The declared session IDs of the chat's runs, in monitor memory, and their expiry | Hold anything but a version 4 UUID and its expiry; persist or serve it |
| `mcp/agent-chat-server.mjs` | The chat's own MCP server with seven observation tools and two read-only task tools | Register a signal, write, or feature tool |
| `desktop/runtime/lan-gateway.mjs` | The chat route and the two chat image routes of a paired device | Forward a chat request to the web host |
| `shared/agent-chat-contract.ts` | Browser-visible types and bounds | Import `server/` or `desktop/` |
| `app/agent-chat-client.ts`, `app/agent-chat-search.ts`, `app/components/agent-chat/` | The transport, the thread as far as it is loaded, the search, and the panel | Keep conversation content in browser storage, or change the board except through the chat's `apply` |

## One turn

[Aril settings and repository memory](tasks.md#aril-settings-and-memory) are included in each provider prompt: settings, including read-only `pairedDevices` and `settledAt` (when the settings were last saved, or null), and oldest-first memory entries (at most 100, each at most 300 characters, with the ISO `updatedAt`).
What the settings and memory answer is settled: Aril acts on it and does not ask the owner again. It asks again only when the owner says a rule changed, or when the [workflow changes](#workflow-changes) list a source that the rule depends on.

Each message of the owner starts one provider run. When an active grant allows writing
tasks, the desktop starts a write turn only when the chat is free. It uses the reviewer
provider when configured, otherwise Claude when available, otherwise Codex; its model is
null.
The run answers and exits. Every
stored Apply or Dismiss starts exactly one provider run for a follow-up (see
[Follow-up](#follow-up)). A follow-up may contain one board-change proposal only after
any applied or partial outcome. The owner must Apply or Dismiss it, which starts its own
single follow-up run; no proposal starts a run or applies itself. Follow-ups never propose a session start, a queue change, or a worktree removal.
The one other run Pomegr starts is a [compaction](#compaction): a read-only run with no tools (Codex keeps its read-only sandbox) in the background that
summarizes an outgrown thread. It is no turn, answers no one, and proposes nothing.

1. The client sends `send` with the repository, the conversation or none (the panel always sends none: see [The thread](#the-thread)), the message,
   the provider, the model or none, the effort or none, and the IDs of the images it added,
   when it added any (see [Images](#images)). The chat panel always names a model once one is
   known and an effort; a client that sends no `effort` key reads as none.
2. Desktop main refuses the message when a turn is already running anywhere (`busy`).
   One turn runs at a time for the whole app.
3. It finds the provider's executable with the same rules a task start uses. No
   executable answers `cli_missing`.
4. It begins every read of the turn together (see [Preparation](#preparation)). The monitor's
   reads are the board (`GET /api/tasks`, with the desktop token), the
   repository root (`POST /internal/tasks/worktree-root`), the observed agent runs
   that the task form's model list reads (`GET /api/agents` for all projects, 90 days,
   all scopes), and `POST /internal/tasks/log-read` for the newest 100 entries, all with the same monitor timeout.
   A board that is not ready, or a repository the monitor has not located in
   this run, answers `unavailable`, without waiting for the other reads. An agents read that fails leaves the Claude list to
   the board's own models. A failed or malformed log read adds an unavailable line; it never refuses the turn.
   Beside them it begins the GitHub settings (once the root is known), the thread's facts, the
   instructions file, and the environment of the run, and, once the root and the board are both known, the workflow changes and
   the cached facts of the Pomegr task worktrees of the repository, which wait for nothing (see [Task worktree facts](#task-worktree-facts)). A read
   that fails leaves its section out and never refuses the turn.
5. It moves the message's images into the conversation while the rest of those reads finish, builds the prompt (see
   [Prompt](#prompt)), and stores the owner's message. Then it declares a Claude Code run to the
   monitor (see [The declared run](#the-declared-run)) and opens the task bridge together, and starts the run in the
   repository root. The answer to `send` is the conversation ID only.
6. While the run writes, `thread` answers the newest page of the thread and a `turn`: the
   answer text so far and one fixed activity label (see [Boundaries](#boundaries)). While a client's panel is open and reads
   no `turn`, the client sends `list` every five seconds. So it follows a turn that
   another device started: a `running` conversation, or an `updatedAt` newer than the
   one the thread was read at, makes the client read the thread's newest page again.
7. When the run ends, desktop main withdraws the declaration and stores Aril's message
   with one status: `complete`, `stopped`, `failed`, or `timed_out`, and with the run's
   [timing](#timing). A run may take ten minutes.
8. After a `complete` turn, an outgrown thread may be summarized in the background (see
   [Compaction](#compaction)). A turn that starts stops that run first.

The run is a new provider conversation every time. Pomegr sends the earlier messages of the thread in
the prompt, so the owner may change the provider, the model, or the effort between two messages.

### Tasks from a grant's plans

The monitor's `write_tasks` step starts one read-only Aril run through the desktop-only `grantWrite({ repositoryId, plans })`; it is not a chat IPC or paired-device operation. It reserves the same slot as `send`, or answers `busy`; the monitor's ten-minute offer spacing paces retries. The queue tick does not await the run and holds one pending write until its outcome is stored.

The prompt contains the normal instructions, board snapshot, settings, memory, workflow changes, and task-log section, with the named plan paths and a fixed grant request instead of an owner message. Aril reads the plans, code, board, and available Git evidence to find the next unbuilt step without a task, then returns one to five tasks in order with the brief, verification, delivery path, and completion conditions. If it cannot find a next step, it answers without a block.

Only this run accepts a `create_task`-only proposal with `text`, optional `complete_when`, `own_condition`, and `runs_after`. Dependencies name existing board tasks or earlier tasks in the answer as `#1` through `#5`; no feature, column, queue, image, or provider run fields are accepted, even when empty. A malformed block, another operation, or an invalid dependency writes nothing and stores `proposalUnreadable`.

Desktop sends `{ repositoryId, plan: plans[0], tasks }` to `grant-write-tasks`, mapping each operation to `{ text, completeWhen?, after? }`. The monitor rechecks grant authority and the cap and creates the batch in Ready. The conversation is titled `Grant: tasks from <first plan file name>`; its proposal is stored as `applied` with `appliedBy: "grant"`, summary `Applied by grant.`, and per-operation task IDs or a fixed refusal. This state records a settled grant attempt, even when refused; it offers no Apply and starts no follow-up. Owner chat turns keep their existing rules.

### Grant follow-ups

While a grant works, Pomegr tells the owner what it did without being asked. It writes one fixed line into the chat, with no provider run and no proposal.

- The monitor answers `grant-follow-ups` with the task-log entries of the oldest grant whose end it has not reported, or else of the latest grant, of the kinds in `ARIL_FOLLOW_UP_LOG_KINDS` (`shared/aril-follow-up.mjs`): `grant_start`, `grant_review`, `review_passed`, `review_failed`, `sent_back`, `grant_merge`, `grant_merge_auto`, `grant_merge_refused`, `grant_branch_deleted`, `grant_branch_delete_refused`, `grant_done` once the task log records it, `grant_usage_hold`, and `grant_usage_resume` ([Tasks: Grant follow-ups](tasks.md#grant-follow-ups)).
- Entries that arrive close together are one batch: a batch is ready 45 seconds after its newest entry, 3 minutes after its oldest, or at 50 entries. The grant's end is a batch of its own at once, or joins the entries still waiting.
- The queue runner asks each tick. For each batch it calls the desktop-only `grantFollowUp({ repositoryId, grant, through, items, more, ended })`, then `grant-follow-up-ack` with the message it wrote, or `null`. A runner without a chat writer asks for nothing.
- `grantFollowUp` builds the line with `arilFollowUpText`: one or two sentences with task IDs and fixed words, never task or provider text. The first sentence lists at most three entries and counts the rest. The second names the tasks that need the owner (a refused merge or branch delete, or a failed review that the burst did not send back), says the grant ended and why, says which provider's new starts wait for usage, or says `Nothing needs you yet.` The line is at most 200 characters.
- Every grant of a repository writes into one conversation, titled `Grant follow-ups`. It is made at the first follow-up, found again by its stored `grantFollowUps` mark, and replaced by a new one only when it holds 200 messages. Its provider is Claude when Claude Code is installed, else Codex. The owner replies in the thread, never in this conversation: [a message does not go to it](#the-thread).
- The mark names the last follow-up written: `{ grant, through, ended, messageId }`. A batch with the same `grant`, `through`, and `ended` answers that message again and writes nothing, so an ack the monitor never received does not add a second line.
- The message is `{ role: "agent", status: "complete", model: null, grantFollowUp: true }` with the line as `text`. It carries no proposal, `followUp`, or `proposalUnreadable`; the store refuses one that does. It carries no effort. The panel draws it as a quiet line (an icon, its text, and its time), not as a message with a head.
- A conversation that is answering, waits for a follow-up turn, or is being sent to answers `busy`, and the runner asks again on the next tick. A conversation that is full is never written to: the follow-up goes to a new one, so a repository's follow-ups are never refused for being full.
- With `followUps` off, the runner writes nothing and acknowledges each batch with no message, and the monitor commits no notification.
- After an acknowledged batch with `followUps` on, the monitor commits one `aril_follow_up` notification with the same facts, so its body is the same line ([Notification privacy](privacy/notifications.md#aril-follow-ups)). Clicking it opens `/tasks?repository=<ID>&aril=<conversation ID>&message=<message ID>`, or `&aril=open` when no message was written. The chat panel then opens in that repository and brings the message into view: it loads older pages of the thread, at most ten, until the message is there. A tray click inside the app does the same through the `pomegr:open-aril-chat` window event.
- A grant follow-up is never a message of the owner and never an answer of Aril's provider run. It does not count as the last completed answer, so the task log since that answer still reaches the next turn. It is in the thread like any message, so the next prompt shows it, in time order, as a grant follow-up that Pomegr wrote from the task log.

### The provider run

The run is the owner's own provider CLI, signed in as the owner. Pomegr reads and stores
no credential, and offers no sign-in of its own. The arguments are fixed
(`chatArguments` in `agent-chat-runner.mjs`); only a validated model identifier, a validated
effort level, the desktop's own MCP server, the desktop's own image folder and image files, and the
session ID desktop main made for the run, the desktop's fixed-instructions file, and whether the run has tools (a [compaction](#compaction) has none) vary.

- **Effort:** the run passes it only when it is exactly `low`, `medium`, `high`, or `xhigh`, as the task dispatcher passes a task's effort (`desktop/runtime/task-dispatch.mjs`). Claude Code gets `--effort <level>` after `--model`. Codex gets `-c model_reasoning_effort=<level>` after `--model`, before the `-` that marks the prompt. Any other value, or none, adds no argument.
- **Claude Code:** print mode with JSON lines, `--no-session-persistence`, and `--session-id` with the run's own ID.
  `--append-system-prompt-file` supplies the fixed instructions, with `--exclude-dynamic-system-prompt-sections` so nearby turns can reuse the system prefix.
  Desktop main atomically writes `AGENT_CHAT_INSTRUCTIONS` to `<desktop data root>/agent-chat-v1/instructions-<sha256>.md`, reusing the file while its content matches.
  The absolute path comes only from the desktop data root and the content hash, and the runner validates that it sits directly inside that folder.
  If writing or validation fails, the turn keeps the instructions in stdin and omits both flags.
  Empty `--setting-sources` excludes user, project, and local settings.
  Inline `--settings` disables hooks and auto memory.
  `--strict-mcp-config` loads only the given `--mcp-config`.
  `--permission-mode dontAsk` refuses tools outside the allow list without asking.
  `--tools Read,Grep,Glob` exposes three native tools.
  The allow list contains those tools, the seven Pomegr observation tools, `get_task`, and `list_tasks`.
  A conversation with images adds `--add-dir` with its image folder.
  Native Read can reach files outside the working directory, subject to provider permissions.
- **No tools:** a [compaction](#compaction) run passes `tools: "none"`. Claude Code gets `--tools ""` and no `--allowedTools`, with no MCP server, no image folder, and no instructions file. Codex has no switch that removes its shell, so it keeps the arguments below with no MCP server and no image, inside its read-only sandbox, and the compaction instructions tell it to use no tool. Any other value of `tools` is the default tool set.
- **Codex:** `exec --json --ephemeral --sandbox read-only --skip-git-repo-check
  --ignore-user-config --ignore-rules --disable apps`, the MCP server as fixed `-c`
  values, and `-` for the prompt on stdin.
  Fixed overrides set `approval_policy="never"`, `features.prefer_mxc=true`, and `windows.sandbox="elevated"`.
  Ignoring user configuration also omits its Windows sandbox selection; these overrides select a native implementation without allowing writes.
  MXC is preferred when supported. The provisioned elevated sandbox is the fallback; administrator-managed requirements still apply.
  See the [Windows sandbox documentation](https://developers.openai.com/codex/windows) for device support and provisioning.
  A message with images adds `--image` with
  its files after the `-`: the flag takes a list of values, so before the `-` it would
  take the `-` as a file.

What the configured run permits, subject to the installed provider's permission policy:

- It reads the repository's files. Claude Code has Read, Grep, and Glob. Codex has its
  shell inside the read-only sandbox.
- It has the seven Pomegr observation tools, `get_task`, and `list_tasks` (see [Tools](#tools)).
- It sees the images the owner sent in this conversation. Claude Code reads their files
  in the one added folder. Codex gets the files of the newest message attached, and can
  read the folder inside its sandbox. The folder holds image files and nothing else.
- It has no tool that writes a file, runs a command that changes something, or reaches
  another MCP server. User, project, and local settings are excluded; hooks and auto memory are disabled.
  Only the explicit MCP server is configured. Administrator-managed provider policies still apply.
- It cannot wait for an approval. A tool outside the allow list is refused.
- It leaves no session file, so nothing can resume it. Claude Code still registers the
  process in its local session registry, where Pomegr finds live sessions; the
  declaration below keeps that registration out of the Sessions list. A Codex run
  registers nothing that Pomegr reads.

For T-136, the owner chose normal provider read access on 2026-10-17, including outside-repository reads permitted by the provider.
Pomegr adds no separate filesystem reader, path filter, or repository-confinement layer.
The selected repository remains the working directory. Provider permissions and the read-only configuration govern file access.
The instructions distinguish Claude's Read, Glob, and Grep from Codex's sandboxed shell.
A shell command is not an available Claude tool. A denied command does not prove that a file is missing.
Aril must report unavailable evidence and must not bypass permissions.

The process starts with `spawn`, an argument array, and `shell: false`. The prompt
travels on stdin, except Claude's fixed instructions when its system-prompt file is available. Nothing the owner typed and nothing from the board is in an argument,
a path, or the environment. An image folder or file is in an argument only in the form
desktop main builds: the chat's directory, a validated repository ID and conversation
ID, and a file named by an image ID that desktop main made. The runner refuses any other
form and then adds no image argument. The environment is the owner's own, read again for
each run as for a task start ([Tasks: Session environment](tasks.md#session-environment),
then `userSessionEnvironment`): the app's own variables and tokens are left out. A
summary run reads it the same way.

**Stop** ends this run. It is Pomegr's own headless process and never a session the
owner started. Closing the app ends a running turn the same way.

### The declared run

Pomegr tells its own Claude Code run apart from a session by an identity it gives the
run, never by a heuristic on registry fields. Print mode, a missing transcript, or a
short life would also match a headless `claude -p` the owner starts by hand.

1. For each Claude Code turn, desktop main makes a random version 4 UUID and passes it
   with `--session-id`. Claude Code writes that ID in the run's registry entry and still
   keeps no session file.
2. Before it starts the run, desktop main sends
   `POST /internal/agent-chat/run-declare?sessionId=<id>` to the monitor with the
   desktop token. A refused or late declaration still starts the run; its row then shows
   while it answers.
3. The Claude adapter drops a registry entry whose session ID is declared at each
   registry read. The entry never reaches discovery, the catalog, the live set,
   liveness, status, a session report, or a notification. Every other entry is admitted
   as before.
4. When the run ends (complete, stopped, failed, or timed out), desktop main sends
   `POST /internal/agent-chat/run-withdraw?sessionId=<id>`.
5. A declaration expires by itself 11 minutes after it was made: the ten-minute turn
   timeout and one minute for the run to exit. If desktop main dies mid-turn, nothing
   stays hidden longer than that.

Limits:

- A run that still runs after its declaration expired shows as a registry-only row
  until it exits.
- A run that started while the monitor did not take the declaration shows for that turn.
- Only the Claude Code run declares. `codex exec --ephemeral` writes no rollout, and the
  Codex adapter drops an ephemeral app-server thread, so a Codex run never shows.

### Tools

The chat's MCP server is `mcp/agent-chat-server.mjs`, bundled as
`desktop/workers/agent-chat-mcp.cjs` and started by the provider run over stdio. The
command is the desktop executable with `ELECTRON_RUN_AS_NODE=1`, so it needs no Node on
the computer and no Pomegr plugin in the repository.

It registers `get_task`, `list_tasks`, and the seven observation tools of
[MCP observation queries](mcp-queries.md): `list_sessions`,
`get_session_report`, `list_session_agents`, `get_agent_context`,
`get_recent_failures`, `get_usage_limits`, and `get_provider_health`. They use the same
loopback routes, the same local descriptor, and the same answers as the plugin's tools.
No host session is bound, so a session tool needs an explicit session reference. The
board snapshot gives the reference of each task's session.

`get_task` takes only `task_id` (`T-n`) and reads that task of the chat's repository. It reuses the [served-task shape](tasks.md#agent-task-read) from T-118 through `shared/task-agent-read.mjs`, with uncut text (at most 4,000 characters) and own condition, and adds only `report: { attention, block_reason }` as the snapshot shapes those lines. Aril calls it when a task it needs has `text_cut`, appears only in the index or Done summary, or needs detail for a comparison. Unknown and cross-repository IDs, malformed answers, and unavailable reads all answer the fixed line `Pomegr task unavailable on this chat's board.`

`list_tasks` takes the coding-session filters (`query`, `state`, `feature`, `editable`) and returns the same JSON result: at most 100 tasks, text cut at 300 characters, plus `matched` and `truncated`. It searches this chat's repository only; it adds no report fields.

Desktop main gives each message and follow-up a temporary loopback bridge, bound in a closure to the same repository as the snapshot. The MCP worker inherits its loopback origin and random read capability (`POMEGR_CHAT_TASK_ORIGIN` and `POMEGR_CHAT_TASK_KEY`) through the provider process environment; the runner removes their values from inline MCP configuration and passes only the variable names to Codex through `env_vars`. Neither value enters provider command-line arguments, the prompt, or a file. This temporary capability permits only the same repository task read offered by the tool, and grants no monitor or write access. The bridge accepts `GET /task?task_id=T-n` and `GET /tasks` with only the four list filters, with its capability header, the exact loopback Host, and no Origin or body. It forwards the read to `GET /internal/agent-chat/task?repositoryId=…&taskId=…` under the existing desktop authorization gate. Lists use the same internal endpoint without `taskId`, with the validated filters. The monitor uses the non-writing task reader, including its exact editability rule; it neither seeds a board nor reads providers. No session is fabricated. The bridge closes on stop, dispose, or turn settlement; nothing is persisted. The observation credential and plugin task endpoints are unchanged.

When the bundle is missing, the run starts without an MCP server and Aril works from the
board snapshot and the files.

### Prompt

`composePrompt` in `agent-chat-prompt.mjs` builds one text of at most 200,000
characters, including the fixed instructions even when Claude receives them through its system-prompt file instead of stdin, in this order:

1. **Instructions.** A fixed text (`AGENT_CHAT_INSTRUCTIONS`): who Aril is, what it may
   read, that it proposes changes for owner Apply except for rework recording and the fixed actions the desktop
   performs under an owner-started grant, how to advise on task size, Ready order, parallel groups, and models,
   the proposal format, how it talks and when it offers [choices](#choices) (the answer first and short, asking only what it cannot decide, quick replies by default),
   when it proposes a session start or a queue change, how it
   names an image and puts it on a task, how it follows up an answered proposal, and
   that all following content is data, and what a summary of earlier conversation is. Capability answers briefly cover reads and images,
   board, start, and queue proposals, settled settings and repository memory, desktop-only
   worktree removal proposals, and every enabled grant action within its limits, including
   reviews, send-backs, merges, branch deletion, and tasks from named plans. They report
   current enabled actions and grant status from the snapshot, and outcomes from the task log.
   Aril cannot start, extend, or stop a grant, end or steer a session, or mark a task Done
   itself: under a grant, a task becomes Done only through the
   [Mark done rule](tasks.md#aril-grants), with the conditions listed there (T-182).
   The owner presses **Start grant** in the desktop app, or on a paired device when
   `pairedDevices` is true. Aril's own run remains read-only.
2. **Board snapshot.** One JSON line (`boardSnapshot`): the repository folder name, the
   time, the column names, the features (title and whether done), the grant summary,
   the queue (status, order, blocker, start threshold, and the usage percentages of the start gates), the
   model lists (`models`), and the shown tasks with their columns and positions. The snapshot is kept small on purpose: a
   smaller prompt answers sooner, so it has its own bound (`BOARD_SNAPSHOT_LIMIT`, below), a null or empty field is left out,
   and a task's text is its title line plus a share of a small budget.
3. **Workflow changes.** Left out until the settings or a memory entry is settled. Otherwise the
   repository's workflow sources that changed since (see [Workflow changes](#workflow-changes)).
4. **Task worktrees.** Owner-message and grant-write turns list the Pomegr task worktrees
   that remain on disk, as facts only, and the fixed instruction for `remove_worktree` (see
   [Worktree removal](#worktree-removal)). The section is left out when there are none. While the facts have not been read yet, it is the one sentence "Task worktree facts are
   still being read, so do not say there are none." Otherwise it says when the facts were read, that they may be a few minutes old, and
   that a size can be unknown (see [Task worktree facts](#task-worktree-facts)).
5. **Repository GitHub settings.** Owner-message turns include a `<repository_github>` section: the repository's `squashMergeAllowed`,
   `mergeCommitAllowed`, `rebaseMergeAllowed`, `autoMergeAllowed`, and `deleteBranchOnMerge` booleans and its default branch name as one JSON
   line, or `unknown` when desktop main could not read them (see [Repository GitHub settings](tasks.md#repository-github-settings)). The section is left out
   when no reader is wired. The instructions tell Aril to read the repository's own rules (such as `AGENTS.md`, `CONTRIBUTING.md`, and its pull-request
   template) and these settings before it proposes `mergeMode`, `deleteBranch`, or a merge method, to propose the value they settle and say where it came
   from, and to ask the owner only what they leave open.
6. **Task log.** Owner-message turns include valid entries newer than the Aril cursor, oldest first, with UTC times and optional pull-request numbers.
   The section reports an empty log, unavailable log, or omitted older entries with fixed lines.
7. **Summary of earlier conversation.** When the repository's thread has a [summary](#the-summary), a `<summary_of_earlier_conversation>` section with a fixed
   line that says what it is and the summary's text, directly before the conversation. Owner-message turns and follow-ups carry it; a grant write turn passes no earlier message and no summary. The section is data, like the conversation, and the instructions say so and tell Aril to say that it no longer has something that neither shows.
8. **Conversation.** The newest earlier messages of the repository's [thread](#the-thread) that fit 24,000 characters, oldest
   first, whichever conversation stores them, so Aril keeps its context across the boundary of two conversations. With a summary, only the messages after the position it ends at are read, and the line "(Earlier messages are left out.)" says that some of those did not fit. A grant write turn passes no earlier message. A proposal is one line with its summary, its outcome, and the IDs it created.
   An answer that offered [choices](#choices) adds one line naming them, and one that offered a block Pomegr could not read says so.
   A session start is one line with the task ID and what happened to it: not answered,
   dismissed, launched, or not started with the fixed start status. A queue change is
   one line with the state it asked for and what happened: not answered, dismissed,
   on, on and held, off, or not changed with the fixed error. A message of the owner with
   images adds one line with their IDs.
   An answer that is a follow-up is marked as one. A proposal of board changes that
   stopped also says how many operations succeeded, which one failed with which fixed
   error, and how many were not applied.
9. **Images.** One line for each image of the conversation whose file is still there:
   its ID, its type, and the absolute file. The section is left out when there is none.
   Image rows share 8,000 characters. Excess rows are omitted whole, with a notice; paths are never shortened.
10. **The owner's message**, and one line with the IDs of its images, in order. A
   follow-up has no message of the owner: its prompt ends with the outcome record and
   one fixed request instead (see [Follow-up](#follow-up)).

Full entries in `tasks` include Ready, In progress, and Review cards, plus cards in any column updated after the latest saved complete Aril answer in this repository; without one, the cutoff is 24 hours before the turn. Owner messages, follow-ups, and grant write turns use the same rule. Failed or interrupted answers never advance it. Deleting all completed answers restores the 24-hour fallback. Dependencies and group neighbors are expanded transitively, including Done cards.

`index` holds every other non-Done card as one string, in column then position order: `T-12 Backlog#3 not_queued [Feature title] group A after T-4,T-5 first line`. Feature titles stop at 40 characters and the text's first line at 80; absent feature, group, and dependency tokens are omitted. Positions remain zero-based and may be used in proposals. A target of a rework link adds the `reworked` token.

`done` holds the total Done count, `by_run` counts grouped by provider, observed model and effort (falling back to planned values), and the ten most recently updated Done cards as index lines. Each group counts tasks with all reported checks passed (at least one), a known failed check, stalled state, blocked state or block reason, and a failed review. Unavailable checks count as neither passed nor failed. These counts describe current served evidence, not lifetime outcomes. `sent_back` is null because the board serves no send-back history. Aril fetches named tasks when comparing the record.

Full entries carry `reworks` and `reworked_by` as `{ ref, cause }` arrays when present. `done.by_run.reworked` counts each linked target or currently failed-review task once. The board exposes no send-back history, so this count cannot include historical send-backs without a surviving link or failed review.

Top-level `rework` holds `days: 30`, `by_cause` counts, and `by_run` rows with provider, model, effort, and count. It counts links declared within the last 30 days, including the cutoff and excluding future times. Only task targets contribute run counts, using observed values before planned values; PR-only targets contribute cause counts. Each link counts once, even when several links name one task. The summary stays complete when task entries are omitted.

Stable snapshot fields precede the volatile `now`, `queue` (including usage percentages), and `grant` fields.

A full task in the snapshot always holds its ID, column, position in that column (`position`, counted
from 0 in the order the Board shows, null when the stored value is not a whole number of 0 or more), state, and task text.
It holds each of the following only when it has a value, and leaves it out when it is null or empty: feature title, planned
provider, model and effort, complete-when checks and own condition, parallel-group label, the IDs
of the tasks it runs after (`runs_after`), `reworks` and `reworked_by`, the linked session's
reference and state, its observed model and observed effort (only where they differ from the plan; the record counts a missing value
as the plan), the report, the review verdict, the GitHub issue number, the scheduled time, and the update time.
The report lists the checks by result, as `passed`, `failed`, and `unavailable` arrays of check names, then `block_reason` and `attention`;
a report with nothing in it is left out. A Done card keeps its run, session reference, and results but not its complete-when checks or own
condition, which `get_task` reads.
Full task text shares a budget of 5,000 UTF-16 code units (`BOARD_TEXT_BUDGET`), so most cards show their title line and a short prefix.
Pomegr reserves each source first line, excluding its LF or CRLF separator, before allocating bodies.
Bodies follow In progress, Review, Ready in actual queue order, then Backlog. A Done card gets no body: it keeps its title line.
Ready cards outside `queue.order` follow queued cards by position and numeric task ID.
Other column ties use position then numeric task ID.
Backlog and custom columns stay last regardless of task state. State supplies priority only when the column projection is absent.
If the remaining text fits, Pomegr includes it whole. Otherwise, it adds at most 240 units of prefix and continues.
That prefix includes any line separator after the title. A cut never splits a Unicode code point.
If titles alone exceed the budget, Pomegr allocates one code point per nonempty task per round, in numeric ID order.
It stops when no next code point fits. A source starting with a newline retains that character; empty source stays empty.
The owner approved this bounded title-overflow rule for T-141 on 2026-10-17.
Each shortened source prefix carries `text_cut`. The snapshot always includes `task_text: { cut, total }`, counting shortened and total full entries only.
Allocation changes neither snapshot card order nor report fields. Aril retrieves needed omitted text with `get_task` instead of guessing.

`BOARD_SNAPSHOT_BUDGET` budgets the complete serialized snapshot, including JSON escaping and every task field.
It is the smaller of two bounds. `BOARD_SNAPSHOT_ROOM` subtracts instruction length, `HISTORY_BUDGET`, `SUMMARY_SECTION_BUDGET` (6,500 characters), 60,000 characters for other sections, and 5,000 characters of margin from `PROMPT_LIMIT`.
It is computed from the current instruction length, including rework instructions and metadata.
`BOARD_SNAPSHOT_LIMIT` (20,000 characters) keeps the snapshot small even when the prompt has room, because a larger prompt is slower to answer.
It was chosen from a synthetic board of 120 tasks, 86 of them Done with texts of 1,400 to 3,800 characters (`tests/helpers/agent-chat-large-board.mjs`): the
snapshot was 66,000 characters before and is about 20,000 now, and the whole prompt fell from about 130,000 to about 82,000 characters.
`tests/desktop-agent-chat-prompt-size.test.mjs` fails when the snapshot, the instructions, or the whole prompt of that board grows past its bound.
The summary section reserves its longest text (6,000 characters) and 500 for its tags and fixed line.
Workflow changes reserve 12,000 characters. Owner turns reserve 10,000 each for task logs and worktrees, 500 for GitHub settings, and 4,000 for messages.
Follow-ups instead reserve 32,000 for the outcome and request. Grant requests reserve 6,000. Image rows reserve 8,000 in either conversation turn.
History includes the separators between messages in its budget.

The budget backstop omits full Done entries by oldest update, then full Backlog entries by highest position, and then index lines from the bottom of Backlog until the snapshot fits. Summary counts remain complete.
Numeric task ID breaks ties. Dependency and group membership do not exempt Done or Backlog tasks from omission.
Ready, In progress, and Review tasks stay. Remaining texts use progressively smaller shared budgets if the snapshot still exceeds its budget.
If retained metadata alone exceeds the snapshot budget, shortening text cannot satisfy it; the whole-prompt limit remains enforced.
Task fields retain their shape. When tasks are omitted, `tasks_omitted: { done, backlog }` counts omitted full entries and index lines by column; cards represented only in the index or Done summary do not count as omitted.
The field is absent when no task is omitted. Omitted tasks still exist on the board.
Aril uses `get_task` with a known ID and states when an answer may depend on tasks not shown.
Its model advice weighs the Done summary and fetches named task records when their details matter. Reworked tasks weigh less for their model and effort than clean merges. When a cause repeats for the same kind of work, Aril proposes `add_memory` with one line naming the missing check.

`models` holds one list for `claude` and one for `codex`. Each list starts with the
models the Run on list of the task form offers for that provider, from the same code
(`modelsByProvider` in `shared/task-run-models.mjs`): for Claude, the newest observed
model of each family; for Codex, the committed client catalog (`runModels.codex`), in
its order. The models that the board's tasks planned or reported follow, sorted, so the
record stays readable. Each list holds at most 64 models, the bound of the Codex
catalog, so a whole catalog fits. Only valid model identifiers are kept; a run or a
catalog row adds nothing else.

The snapshot holds no path, token, repository ID, column ID, feature ID, image, or
dispatch fact. A feature's description and app version are not in it.
The grant summary is null before a grant. Otherwise it contains `active`, the ISO
`ends_at`, `starts_used`, and the snapshotted `limits` and `actions`; an ended grant also
contains its fixed `end_reason`. These fixed grant facts reach the provider with each
snapshot and do not include its start time or a grant identifier.

Aril chooses the provider, model and effort of each task it proposes on its own. It
does not copy them from the newest task. It weighs the kind of work (a small located UI
fix, a cross-layer trace, a design or a prototype, an instruction change, or a probe
that writes no code), the size, the risk, the board's record for tasks of the same kind
(where an unavailable result is never a failure), and both providers' usage against the
start threshold. Both providers' lists are candidates for every task. Aril names in one
line why it chose each model and effort, recommends only a model that `models` lists or
a provider's default model, and says so when the record cannot tell. A preference the
owner states wins. It may still copy `complete_when` from the newest task of the same
kind.

Aril's advice on models is a reading of this recorded evidence. It is never presented as
a measurement or a benchmark.

### Workflow changes

A settled rule is not asked again unless the repository's workflow changed. Every Aril turn
(an owner message, a follow-up, and a grant write turn) therefore reads the workflow sources
in the repository root before the prompt is built (`readWorkflowChanges` in
`agent-chat-workflow.mjs`):

- **Sources.** The files that exist among `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`,
  `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and
  `.pomegr/signals.md`, then the files under `.github/workflows/` in name order, at most 40.
  A name is kept only when it is repository-relative, has no `..` or control character,
  and has at most 200 characters.
- **Settled time.** The oldest of the settings' `settledAt` and the `updatedAt` of every
  memory entry. With none, nothing is settled: the section is left out and Git does not run.
- **Read.** `git log -1 --format=%ct` for each source and one `git status --porcelain` for the set,
  started with `execFile` and an argument array, no shell, in the repository root, read-only
  (`--no-optional-locks`, literal pathspecs, no file-system monitor), within 5 seconds in total.
- **Kept facts.** On 2026-10-29 an owner's turn spent 1.9 s on this read, the slowest step of its preparation. What the read learns from
  Git (the last commit of each source, which sources are uncommitted and when each was last edited) is kept in memory for each root, with a
  key made of the files alone, without a Git process: the HEAD commit (read from `.git/HEAD`, the ref file or `packed-refs`, through the
  `.git` file and `commondir` of a linked worktree), the time and size of `.git/index`, the root `.gitignore`, and `.git/info/exclude`,
  and the times and size of each source and the list of sources. The settled time is not in the key: the changes are worked out from the kept
  facts on every turn. A turn whose key is the kept one starts no Git process. Any difference (a commit, a staged, edited, added or removed source),
  a key that cannot be read (no repository, an unborn branch, a ref it does not read, a reference outside `refs/`), or facts older than 5
  minutes reads everything again as above. A read that failed or timed out keeps nothing. A turn never answers from facts whose key differs.
- **Section.** One line for each source whose last commit is after the settled time, or that has
  uncommitted changes: its path, the date (the last commit, or the last edit of an uncommitted
  file), and `committed` or `uncommitted`. When none qualifies, the line "No workflow source changed
  since your settings and memory were settled." When Git fails or the time runs out, the line
  "Workflow changes are unknown." and nothing else.

The section holds names and dates only. Aril reads a listed file itself, then proposes an update
to the setting or memory entry, or asks only about what the change left unclear.

## Proposals

Aril changes the board only by ending its answer with one fenced block tagged
`pomegr-board`: `{ "summary", "operations" }`. `extractProposal` in
`agent-chat-proposal.mjs` takes the block out of the shown text and validates it.

A [grant task-writing answer](#tasks-from-a-grants-plans) applies one to five `create_task` operations from the named plans, within the grant's cap. No other operation is accepted in that answer. Outside grant writes, desktop main records `declare_rework` operations at answer time, without Apply; remaining operations retain their approval boundary.

When the owner or task text, a fix PR, or the log establishes that work fixes or redoes earlier work, Aril declares the link. One answer may contain at most five declarations, alone or beside other operations, including in a follow-up after any outcome. Declarations are removed before the remaining proposal's isolation and follow-up rules apply. A declaration-only answer has no Apply. Each result becomes a fixed answer line: `Recorded: T-12 reworks #336 · missed wiring`, `Already recorded: T-12 reworks #336`, or `Not recorded: T-12 reworks #336 · missed wiring · not_found`. Refusals use only `invalid`, `not_found`, `limit`, or `unavailable`; no monitor text crosses. Duplicate declarations retain the first cause. Recording starts no follow-up.

Aril ends its answer with a proposal when the owner asked for a change, agreed to one, or
when its own reading recommends one concrete board change, with the reason in the answer;
it never ends by asking whether it should propose. A start, a queue change, and a delete
still need the owner's own request, and an answer that is advice only carries no
proposal. Aril asks one question instead only when different readings of the owner's
message would lead to materially different proposals.

- A proposal holds 1 to 40 operations and a one-line summary of at most 300 characters.
- An answer with two blocks, an unclosed block, malformed JSON, or one operation outside
  the contract carries no proposal. The message is marked `proposalUnreadable`, and the
  panel says so. Nothing is offered and nothing is guessed.
- Only a `complete` answer can carry a proposal. A follow-up may carry one only
  after any applied or partial outcome, and only as a board-change proposal continuing
  the owner's earlier request. Follow-ups never propose `start_session`,
  `set_queue`, or `remove_worktree`. An ineligible or invalid block is removed and marked
  `proposalUnreadable`; the block is not stored.
- While the answer is written, a block that has begun is not shown.

| Operation | Fields | Task action when approved |
| --- | --- | --- |
| `create_feature` | `name` | `feature_create`; a feature of that title that is already open is the outcome asked for, so nothing is sent |
| `update_feature` | `feature` (the exact title, done or not); at least one of `name` (a new title) and `done` (a boolean) | `feature_update` with `{ id, name?, done? }`; a title another feature has answers `conflict`, and marking done or reopening moves, unqueues, and deletes no task. Desktop window only |
| `delete_feature` | `feature` (the exact title, done or not) | `feature_delete` with `{ id }`, sent only when no task of the board, a Done one included, has the feature; otherwise `conflict` without a request. Desktop window only |
| `create_task` | `text`; optional `feature`, `provider`, `model`, `effort`, `complete_when`, `own_condition`, `queue`, `images`, and a placement: `column` with an optional `position`, or `place_after` | `create`, then the image request for each image, then `move` when it has a placement, then `queue_add` when `queue` is true |
| `update_task` | `id`; any of `text`, `feature` (null takes the task out of its feature), `provider`, `model`, `effort`, `complete_when`, `own_condition` | `update` |
| `delete_task` | `id` | `delete` |
| `move_task` | `id`, `column`; optional `position` | `move`; without a position the card goes last |
| `queue_task` | `id` | `queue_add` |
| `unqueue_task` | `id` | `queue_remove` |
| `group_tasks` | `ids`, 2 to 16 distinct task IDs | `queue_group` with `{ ids }` |
| `ungroup_tasks` | `ids`, 1 to 16 distinct task IDs | `queue_ungroup` with `{ ids }` |
| `set_after` | `id`, and `after`, 0 to 8 distinct task IDs other than `id` | `after_set` with `{ id, after }` |
| `attach_images` | `id`, `images` | None. The image request for each image the task does not hold: see [An image on a task](#an-image-on-a-task) |
| `start_session` | `id` | None. It is not a board change: see [Session start](#session-start) |
| `remove_worktree` | `id`, `branch` (a boolean) | None. It is not a board change, and a proposal holds only these, 1 to 30: see [Worktree removal](#worktree-removal) |
| `set_queue` | `on`, a boolean | `queue_settings` with `{ on }`, sent on its own path: see [Queue change](#queue-change) |
| `set_aril_settings` | `settings`: a subset of `actions`, `mergeMethod`, `mergeMode` (null, `direct`, or `auto`), `deleteBranch` (null, true, or false), `limits`, `workRules`, and `reviewer`; each supplied field replaces the whole field | `aril_settings_set` with `{ settings }`; it must be the only operation |
| `add_memory` | `text` | `aril_memory_add` with `{ text }` |
| `update_memory` | Numeric `id`, `text` | `aril_memory_update` with `{ id, text }` |
| `remove_memory` | Numeric `id` | `aril_memory_remove` with `{ id }` |
| `declare_rework` | `fix`, `reworks`: distinct `T-n` or `#n` references; `cause`: `missed_wiring`, `spec_gap`, `wrong_behavior`, `stale_instructions`, `latent`, or `other` | Desktop-main-only `aril-declare-rework` records with declarer `aril`, without Apply; never a grant task-write operation |

Settings and memory proposals are available only on owner-message turns, never follow-ups. `set_aril_settings` cannot include `pairedDevices`; paired-device Apply answers `desktop_only` unless stored `pairedDevices` is true. Desktop Apply keeps the existing action behavior.
Memory operations combine only with memory operations. Validation mirrors the [settings and memory bounds](tasks.md#aril-settings-and-memory); the monitor checks feature and task membership.
Aril proposes settings only when the owner requests a change or agrees to a suggestion. It asks before relying on unsettled limits or missing rules.

- A feature is named by its exact title. Desktop main resolves it against the board when
  the proposal runs, so a `create_task` may name a feature that an earlier
  `create_feature` of the same proposal makes. `create_task` and `update_task` match only
  a feature that is not done; `update_feature` and `delete_feature` match a done one too,
  so a done feature can be reopened.
- A feature edit (`update_feature` or `delete_feature`) uses the desktop's own feature
  actions, which the paired-device route does not have. A proposal that holds one answers
  `desktop_only` on a paired device before any action, and stays pending. Aril proposes
  `delete_feature` only when the owner asks, and says that it cannot be undone. The
  coding-session MCP feature tools are unchanged.
- An update sets only the parts it names. The applier fills the rest of `run` and
  `completeWhen` from the stored task, and keeps the task's Remote Control and
  keep-worktree flags.
- The monitor validates every action as it does for the desktop app. The rules of
  [Tasks](tasks.md) hold: a started task is read-only, a waiting card stays in Ready,
  and a bound applies.
- **A placement puts a new card in its place in the same proposal** (task T-102,
  2026-10-15). `column` names one of the five columns, and `position` counts from 0 as in
  `move_task`; without a position the card goes last in that column. `place_after` names
  a task of the board, and the card lands right under it, in that task's column. The two
  forms never mix, and a position needs its column. Without a placement the card lands at
  the end of Backlog, as before. The applier sends the ordinary `move` after the create,
  on the board the create answered, with the position counted without the new card: the
  store keeps one placement rule. A placement never queues: a card placed in Ready waits
  there unqueued unless `queue` is true, and `queue_add` follows the move.
- **A placement that fails keeps the task.** A column the board does not hold, or a
  `place_after` task it does not hold, answers `not_found` without a request; a refused
  `move` answers its error. Either result carries the new task's ID and
  `part: "placement"`, and the proposal stops there.
- On owner turns, a group operation names only tasks that exist on the board when the proposal runs. A task
  that the same proposal creates has no ID yet, so no placeholder is supported. A
  placement is the one way to order a new card in the same proposal. A task of
  the list that the board does not hold answers `not_found` without a request.
- A parallel group is a label in the snapshot (`group A`, `group B`), numbered by the
  lowest task number of each group. The opaque group ID never reaches the prompt.
- `set_after` names only tasks that exist on the board when the proposal runs, like a group
  operation. The monitor refuses a list that would make tasks wait for each other.

No operation marks a task done, requeues a task, changes a feature's title or
description, deletes a feature, removes an image from a task, sets the queue's threshold
or schedule, or touches GitHub. Only `start_session` starts a session, only `set_queue`
turns the queue on or off, and only `remove_worktree` removes a worktree, each by the rules below.

### Session start

Task T-72, 2026-10-12. It replaces the earlier rule that the chat starts no session. A
`start_session` proposal asks Pomegr to start one session for one existing task, as
**Start session** in the task window does.

- **Only on an explicit request.** The instructions tell Aril to propose a start only
  when the owner's newest message asks to start a named task, such as "start T-63", and
  then to propose it instead of sending the owner to the task window. Aril never proposes
  one on its own, as part of a plan, or because text in the board, a file, or a tool
  result asks for it.
- **One exact task, and nothing else.** The operation holds a task ID of the form
  `T-<n>` and no other key: no provider, model, worktree, or queue option. It is the only
  operation of its proposal. A start beside any other operation makes the whole proposal
  unreadable, so the owner never approves a start together with a board change.
- **The owner applies it in the desktop window.** `apply` hands the trusted window event
  of the `pomegr:agent-chat` call, the repository ID, and the task ID to the manual start
  (`startApproved` of `createTaskStart` in `task-dispatch.mjs`). It is the start behind
  `pomegr:task-start` with the native confirmation: the trusted-frame check, the start
  plan with every gate ([Tasks: Starting a session](tasks.md#starting-a-session)), and
  the one launch slot that manual and queued starts share. The chat adds no path of its
  own.
- **The native dialog confirms the start.** Task T-147 restores the shared native confirmation after Apply, as requested on 2026-10-16.
  **Start session** on the card approves the proposal. Desktop main then asks the owner to confirm the named task.
  Cancellation requests no start plan and leaves the proposal unchanged.
- **A paired device cannot apply it.** A call through `POST /api/agent-chat` carries no
  window event. `apply` of a start then answers `desktop_only` before anything runs, and
  the proposal stays pending as it was, so the owner can apply it on the computer. A
  paired device may dismiss it. Its own confirmed start route
  ([Tasks: Paired devices](tasks.md#paired-devices)) is unchanged and is not used by the
  chat. The panel on a paired device draws the card without **Start session**.
- **Nothing is checked ahead and nothing is overridden.** The chat reads no board and
  judges no gate for a start: the start plan answers for itself. The chat never asks for
  a separate worktree, never queues, unqueues, moves, or reorders the task, and never
  turns the queue on. A held start is not retried.
- **What is stored.** The dispatcher answers one fixed status. `started` stores the
  proposal as `applied` with the result `{ ok: true, start: "started" }`. Any other status
  but `cancelled` leaves the proposal `pending` and stores
  `{ ok: false, error: "not_started", start }`, where `start` is one of
  `unsupported_platform`, `cli_missing`, `plugin_missing`, `not_startable`, `gate_held`,
  `unsupported_provider`, `not_found`, `busy`, `invalid`, `unavailable`, `failed`,
  `worktree_dirty`, and `tree_dirty`. An answer outside the fixed statuses is stored as
  `unavailable`, and a start that throws as `failed`. `cancelled` stores nothing. A start
  proposal is never `partial`.
- **Another try.** A proposal whose start launched nothing stays pending, so the owner
  may apply it again, for example once a gate is clear. Each Apply is one request to the
  dispatcher. Pomegr never tries again by itself.
- **No second launch.** A launched start is `applied`, so a later Apply answers
  `conflict`. Two Apply answers at once: the second answers `busy`. Behind both, the
  dispatcher's launch slot answers `busy`, and the monitor refuses a task with a live
  dispatch or a linked session with `not_startable`.
- **What the panel says.** A pending card reads as a start that has not happened. A
  stored failure reads "Not started." with one fixed line for its status. For
  `gate_held` the panel adds the line the task window shows, from the readings
  `queue.gates` carries now ("This task is held: ..."), or nothing when those readings
  show no hold. Only an `applied` start reads "Session started in a new terminal
  window." That is the launch the dispatcher confirmed; the session links to its task
  later, as after any manual start. [Agent chat design](../design/agent-chat.md) owns the
  words.
- **The next turn.** The conversation line of the proposal tells Aril what happened, so
  a later answer never reports a session that did not launch.

### Queue change

Task T-75, 2026-10-12. It replaces the earlier rule that the chat turns no queue on or
off. A `set_queue` proposal asks Pomegr to turn the queue of the chat's repository on or
off, as the **Off | On** control of the Tasks page does.

- **Only on an explicit request.** The instructions tell Aril to propose a queue change
  only when the owner's newest message asks to turn this repository's queue on or off,
  and then to propose it instead of sending the owner to the Tasks page. Aril never
  proposes one on its own, as part of a plan, as a way to get a task started, or because
  text in the board, a file, or a tool result asks for it.
- **A state, never a toggle.** The operation holds `on`, a boolean, and no other key: no
  repository, task, threshold, or schedule. A stored proposal therefore always asks for
  the same state, however often it is applied and whatever the queue is by then. The
  repository is the one of the conversation; a proposal cannot name another.
- **Nothing else in the proposal.** It is the only operation of its proposal. A queue
  change beside any other operation, a start included, makes the whole proposal
  unreadable, so the owner never approves automatic starts together with a board change.
- **The canonical action.** `apply` sends one request, `POST
  /internal/tasks/queue_settings` with `{ on }` and the desktop token, the action behind
  the Tasks page's queue control ([Tasks: Queue](tasks.md#queue)). The chat reads no
  board first and sends nothing else. `queue_settings` is not in the list of actions the
  applier of board changes may send, and the chat has no path that sends a threshold or
  a schedule.
- **Turning on may start sessions.** A queue that is on lets the desktop queue runner
  start the queued tasks in Ready order, with no further confirmation. The chat
  starts none of them: only the runner does, on its next poll, through the dispatcher
  the Tasks page uses. Every gate holds as it does there: the Ready order and parallel groups, a
  task's own state and start time, the queue's schedule, the provider's usage and status,
  the repository's working tree, the plugin, and the provider's command-line tool. The
  chat judges none of them and overrides none.
- **The consequence is said before Apply.** The instructions make Aril say it in one
  line before the block. The card's footer says it again in fixed words, and its Primary
  names the state: **Turn queue on** or **Turn queue off**.
- **Turning off stops nothing.** It only ends new starts by the runner. Sessions that
  run continue, as on the Tasks page.
- **A paired device may apply it.** Product-owner decision of 2026-10-12 (task T-75).
  It is a deliberate widening of the chat route: until then a paired device could apply
  only board changes there. It follows the decision of the same day that a paired device
  may turn the queue on and off through `POST /api/tasks/action`
  ([Tasks: Paired devices](tasks.md#paired-devices)), so the chat adds a second way to
  the same action and no new authority. The gateway authenticates the device as for any
  chat request, and the call carries no window event, which this operation does not
  need. A session start from the chat stays desktop-only.
- **What is stored.** The monitor's answer decides. An accepted change stores the
  proposal as `applied` with `{ ok: true, queue }`: `on`, `off`, or `blocked` when the
  answered board reads the queue as blocked at a stalled or blocked task. A change the
  monitor refused, or that never reached it, leaves the proposal `pending` with
  `{ ok: false, error }`, one of `invalid`, `not_found`, `limit`, `conflict`,
  `unsupported`, and `unavailable`. A queue proposal is never `partial`.
- **Repeated Apply is safe.** An applied proposal answers `conflict`, and two Apply
  answers at once make the second `busy`, so one proposal changes the queue at most
  once. A proposal whose change was not made stays pending, and another Apply sends the
  same `{ on }` again. Behind both, the monitor treats `{ on: true }` on a queue that is
  already on as no change.
- **What the panel says.** A pending card reads as a change that has not happened. An
  applied one reads "Queue turned on.", "Queue turned off.", or that a stalled or
  blocked task holds the queue. A stored failure reads "Queue not changed." with one of
  two fixed sentences: Pomegr refused the change, or Pomegr did not answer. The panel
  never says that a task started. [Agent chat design](../design/agent-chat.md) owns the
  words.
- **The next turn.** The conversation line of the proposal tells Aril what the queue
  became, so a later answer never reports a change that was not made.

### Worktree removal

Aril operator phase 9c, owner decision of 2026-10-25. Task worktrees take disk space (see
[Tasks: Worktrees](tasks.md#worktrees)). A `remove_worktree` proposal asks the owner to
remove task worktrees that Pomegr made. Nothing is removed until the owner applies it in
the desktop app, and every removal keeps the safety checks of the removal that Mark done
runs.

- **What Aril sees.** The `<task_worktrees>` section of an owner-message or grant-write
  prompt. Desktop main lists the worktrees that Git knows for the repository root and that
  are at `<root>/.pomegr/worktrees/<task ID>` or at the legacy
  `<desktop data root>/task-worktrees/<repository ID>/<task ID>`. The task ID is taken from
  the validated folder name only. A row is a JSON line with the task ID, the task's `state`
  and `column` from the board of this turn or "not on board", `clean`, `uniqueCommits` (HEAD holds a
  commit that exists on no remote and no other branch), and `size` in MB, "at least N MB"
  when the walk stopped at 20,000 entries, 2 seconds, or the 6 seconds that all the walks of one refresh share, or "unknown" until a walk has
  measured it. A fact that cannot be read counts
  against removal: not clean, and a unique commit. There are at most 30 rows, oldest task
  first. The facts are not read for each turn: they are the cached facts of
  [Task worktree facts](#task-worktree-facts), and a line under the rows says when they were read. A path is never in a row, the prompt, the store, the renderer, or a log. A
  follow-up reads no listing.
- **When Aril proposes it.** The fixed text under the rows tells Aril to propose removal
  when the owner asks about disk space or cleanup, or when a done or deleted task still has
  a worktree; to tell the owner, not propose, when a worktree has uncommitted changes or a
  commit that exists nowhere else; and never to propose it for a task in progress, or in
  Review with a session running. The listing is data, not a decision: the checks below run
  again at Apply.
- **The operation.** `{ "op": "remove_worktree", "id": "T-12", "branch": true }` with a
  task ID and a boolean `branch` that says whether to also delete `tasks/<id>` under the
  [branch rule](tasks.md#worktrees). Another key, a missing `branch`, or any other
  operation beside it makes the whole proposal unreadable, like a start. A grant answer and
  a follow-up never carry it.
- **Only in the desktop window.** `apply` hands desktop main the trusted window event, as a
  start does. A call without one, which is every paired-device call, answers `desktop_only`
  before any board read or Git call, and the proposal stays pending. A paired device may
  dismiss it, and its card has no Primary.
- **Apply.** For each operation in order, desktop main reads the board again; answers
  `in_use` when the task is in flight (a session is linked and it has no outcome, or its
  dispatch is live) or its review session is running; finds the worktree with the lookup
  that Open folder uses; and runs the unforced removal of `task-worktree.mjs`, with the
  branch rule when `branch` is true. A task that is no longer on the board is removed the
  same way. It adds no monitor route: the board and the existing private task read answer.
  A `run.keepWorktree` flag that is on does not stop it, because the owner's Apply is the
  choice; the flag is not changed. The removal never asks the cached facts of the prompt: `remove` reads the Git listing, the working
  tree (`status`), and the commits (`rev-list`) again, so a row that went stale cannot allow a removal that the live state forbids.
  Whatever the result, Apply then tells the cache that its facts are out of date, and a removed worktree leaves the rows at once.
- **Results.** One fixed word for each operation: `removed`, `not_found` (no such
  worktree), `dirty` (uncommitted changes), `unique_commits` (a commit that exists nowhere
  else), `in_use`, or `failed` (Git or the file system refused, or an answer was missing).
  A kept worktree does not stop the next one. The proposal is `applied` when every
  worktree was removed, else `partial`, and the stored result is `{ ok, worktree }` with
  `error` set to the word when `ok` is false. The apply answers `{ ok: true }` either way.
- **What is stored.** The task IDs, the `branch` booleans, and one fixed word each. No
  path, Git output, size, or error text.
- **The next turn.** The outcome record is `worktree_removal`, with one row for each
  operation and its result word, and its fixed request tells Aril to report each task ID
  with its result and that a worktree which was not removed is still on disk. A dismissal
  reads like any other.
- **What the panel says.** [Agent chat design](../design/agent-chat.md) owns the words.

### Approval

A stored proposal is `pending`. The owner answers it once.

- **Apply changes** (`apply`) of a proposal of board changes reads the board, then runs
  the operations in order, one task action each (`applyOperations`). It stops at the first operation that fails. The
  operations after it answer `skipped`. The proposal becomes `applied` when every
  operation succeeded, else `partial`, with one result per operation: success, the new
  task's ID, or one fixed error. A failure with `part: "images"` stopped at an image. A
  failure with `part: "placement"` stopped at the placement of a task it created, and
  names that task.
- **Start session** is the `apply` of a start proposal. It reads no board and sends no
  task action (see [Session start](#session-start)).
- **Turn queue on** and **Turn queue off** are the `apply` of a queue proposal. It reads
  no board and sends the one queue action (see [Queue change](#queue-change)).
- **Remove worktree** and **Remove worktrees** are the `apply` of a removal proposal. It
  reads the board before each operation and sends no task action (see
  [Worktree removal](#worktree-removal)).
- **Dismiss** (`dismiss`) stores `dismissed` and sends nothing.
- A proposal that is not `pending` answers `conflict`. Two answers at once: the second
  answers `busy`.
- What runs is the stored proposal, the one the panel showed. The client sends only the
  proposal's ID.
- A proposal can be stale when the board changed after Aril wrote it. Nothing is
  checked ahead: each action answers for itself, and a task that is gone is `not_found`.
- Nothing is undone. A deleted task stays deleted, as on the Tasks page.
- Every answer that was stored asks Aril for one follow-up (see [Follow-up](#follow-up)).

### Follow-up

Task T-95, 2026-10-13. After the owner applies or dismisses a proposal, Aril answers
once more in the same conversation, so the owner reads what happened without sending
another message.

- **Desktop main asks, once per stored outcome.** `resolve` stores the outcome first and
  then asks for the follow-up. No client asks for it: the panel only reads. So a second
  click, a client that reconnects, and a panel that draws again cannot make a second
  one. A second answer to a proposal that is not `pending` answers `conflict`, and one
  that arrives while the first runs answers `busy`; neither stores anything, so neither
  asks.
- **An answer that stored nothing asks for nothing.** That is an Apply that answers
  `unavailable` because the board could not be read, `desktop_only`, `conflict`,
  `busy`, `not_found`, and a start the dispatcher cancelled.
- **A start or a queue change that was not made is an outcome too.** Its proposal stays
  `pending` with the fixed result, and each Apply of the owner is followed up once.
- **It is a turn like any other.** The same provider run, with the provider, model, and effort
  the conversation used last. It has no tool that writes. `read` answers its `turn`,
  **Stop** ends it, and a message of the owner sent meanwhile answers `busy`.
- **The outcome record.** `proposalOutcome` in `agent-chat-prompt.mjs` builds it from the
  stored proposal: the kind (`board_changes`, `session_start`, `queue_change`, or `worktree_removal`), the
  proposal's summary, one of the five outcomes below, and for board changes one row for
  each operation with its number, its name, the task IDs it names, the feature title or
  the column it wrote, and `succeeded`, `failed` with the fixed error, or `not_applied`.
  A `create_task` row also holds the `column` or `place_after` of its placement. A new
  task that was created before its operation failed is named under `created`, with
  `placed: false` when its placement failed.
- **The board is read again.** The follow-up reads `GET /api/tasks` after the outcome
  was stored, so the snapshot of its prompt shows the board as the apply left it.
- **The request is fixed.** It tells Aril that the owner sent no message, gives one fixed
  text for the kind and outcome, and says what is confirmed. After an applied or partial
  outcome, Aril may return one proposal of board changes that continues the owner's
  earlier request. The ordinary parser and validator accept at most one
  proposal block, with 1 to 40 operations. A complete follow-up after a dismissed,
  refused, or failed outcome cannot offer a pending proposal; after recording rework declarations, any remaining block is rejected and the
  message is marked `proposalUnreadable`. A follow-up never proposes
  `start_session`, `set_queue`, or `remove_worktree`. Applying or dismissing an eligible follow-up
  proposal starts one provider run for its follow-up; it does not start an automatic
  chain.

| Outcome | When |
| --- | --- |
| `applied` | Every operation succeeded; the session launched; the monitor accepted the queue state |
| `partial` | At least one operation changed the board, and then one failed. The operations after it were not applied |
| `refused` | Nothing was changed: the monitor refused the first operation or the queue change with a fixed error, or a start gate or the task's state held the start |
| `failed` | Nothing is confirmed: the monitor did not answer (`unavailable`), or the start could not be made (`failed`, `unavailable`) |
| `dismissed` | The owner declined the proposal. No operation was applied |

- **Truthful by instruction and by record.** The instructions tell Aril to report only
  what the outcome and the snapshot confirm, and never a failed or not applied operation
  as done. A queued task and a queue that is on are not a session: Aril says that a
  session started only when the outcome says Pomegr launched it, or the snapshot shows a
  session on the task.
- **A dismissal is not a failure.** The request says that the owner declined the
  proposal and that nothing was applied, and asks for one sentence. The instructions
  tell Aril not to ask why, not to offer a variant, and not to propose it again unless
  the owner asks. The stored proposal is `dismissed`, and every later prompt says so in
  its conversation line.
- **Only rework recording happens without Apply.** Even under a grant, a follow-up takes no
  [grant action](tasks.md#aril-grants), sends no task action, retries no
  operation, starts no session, and changes no queue: it is a read-only run. Only a
  complete follow-up after any applied or partial outcome may carry one board-change
  proposal. It continues the owner's earlier request and uses the ordinary
  parser and validator. The owner must Apply or Dismiss it. Each answer starts one
  follow-up run, with no automatic chain. A follow-up never proposes `start_session`,
  `set_queue`, or `remove_worktree`. A block that is invalid or ineligible is removed from the answer and
  the message is stored with `proposalUnreadable`; its block is not kept.
The instruction to continue only the owner's earlier request is prompt guidance.
Runtime checks enforce the outcome and operation types; the owner reviews the proposed
work before Apply.

- **What is stored.** One agent message with `followUp`, the ID of the proposal it
  answers, and the run status. It may also hold the one validated board-change proposal,
  or `proposalUnreadable` when a block is rejected. The outcome record is built for
  the prompt from the stored proposal and is not kept by itself.
- **A turn that already runs.** The follow-up waits for the one turn, in memory, oldest
  first. The proposal's outcome is stored at once and the board is usable meanwhile.
  The thread's `turn` is `starting` while it waits, so the
  client keeps reading. **Stop** takes a waiting follow-up back,
  and deleting its conversation drops it.
- **A provider that cannot answer.** With no provider CLI, no board, or no repository
  root, and for a run that fails, the follow-up is stored as one message with the status
  `failed` and no text. The proposal keeps its outcome, and nothing is tried again.
- **Not asked.** A conversation that is gone or holds 200 messages gets no follow-up.
  A follow-up that waits when the app closes is not written later: the outcome is in the
  conversation, and the next turn reads it.

## Choices

Aril talks just enough (the owner's rule of 2026-10-28, Aril agent plan, phase 2): the answer first, in as few words as carry it, and detail only on request. A question is asked with quick replies by default, and with one multiple-choice question only when each option needs a line of trade-off. Aril asks only what it cannot decide itself. A choice is a convenience for the owner's reply and carries no authority.

### The block

Aril offers choices by ending its answer with one fenced block tagged `pomegr-replies`, in one of two forms. `extractChoices` in `agent-chat-choices.mjs` takes the block out of the shown text and validates it; `extractProposal` then reads what is left.

- **Quick replies:** `{"replies": ["Squash", "Merge commit", "Tell me more"]}`. 1 to 4 replies, each one line of at most 40 characters.
- **One question:** `{"question": "...", "options": [{"label": "...", "detail": "..."}, ...]}`. The question is one line of at most 120 characters. There are 2 to 4 options, each exactly a label of at most 60 characters and a detail of one line of at most 120 characters. The first option is the one Aril recommends, and the panel marks it. There is no option for a free answer: the composer is the free answer.
- **Strings:** every string is trimmed, not empty, and holds no control character, line break, or U+2028 or U+2029. No two replies, and no two option labels, are the same whatever their case.
- **Strict reading:** the block is JSON of at most 8 KiB with exactly the keys above. An extra key, both forms in one block, a second block, a block that was never closed, or a value outside these bounds makes the block unreadable.
- **Unreadable is silent:** an unreadable block is dropped and the answer text stays. The message is stored with `choicesUnreadable: true`, which the panel does not draw. The next prompt reads it, so Aril never assumes buttons that the owner did not see. It works as `proposalUnreadable` does, without a notice.
- **While the answer is written:** a block that has begun is not shown, and an answer that does not complete shows its text without the block and stores no choices (`shownAnswer`).

### Where they are dropped

- Only a `complete` answer stores choices.
- An answer that carries a proposal carries no choices, because the proposal has its own Apply and Dismiss. The block is dropped with no mark, and so is a block beside an unreadable proposal.
- A grant task-writing turn stores none.
- A follow-up after an outcome may offer choices when it carries no proposal.
- A grant follow-up line is written with no provider run and never carries any. The store refuses a record that says it does.

### What is stored and served

- `choices` on the agent message is `{ replies }` or `{ question, options }`, in the one shape above.
- The store keeps only that shape. A value outside it is left out, and the message is kept.
- `read` and `thread` return the field with the message, as they return the answer text. `search` finds message text only, not choices.
- The next prompts show each answer's choices as one line: the replies, or the question and the option labels without their details.

### What a choice does

- A tap sends the label as the owner's own message through `send`, with the composer's repository, model, and effort.
- No operation, payload key, route, or channel was added for choices, so a choice has no authority beyond a message the owner could type.
- Whether a choice can still be tapped, and which one the owner picked, are decided by the panel from the thread. They are not stored. [Agent chat design](../design/agent-chat.md#choices) owns the look.

## Images

Task T-86, 2026-10-13. The owner may send images to Aril, such as a screenshot or a
mock-up, and Aril may propose to put them on a task. Aril makes, changes, and fetches no
image: every image is one the owner sent in the same conversation.

### Sending an image

- **Formats and bounds.** PNG, JPEG, GIF, or WebP, decided from the leading bytes
  (`sniffChatImageType`), never from a name or a declared type. An image is at most
  5 MiB. A message holds at most four images and a conversation at most 40. A message
  with images still needs text.
- **Added before the message is sent.** The client hands the bytes to desktop main with
  the image operation `add`. Desktop main makes the image ID (`img-<12 random hex>`),
  writes the file to
  `<desktop data root>/agent-chat-v1/<repository ID>/images/staged/<image ID>.<png|jpg|gif|webp>`,
  and answers the ID, the type, and the size. It keeps the newest 16 staged files of a
  repository and removes the older ones, so an image of a message that was never sent
  does not stay.
- **Taken by the message.** `send` names the image IDs. Desktop main moves those files
  to `.../images/<conversation ID>/` and stores `images: [{ id, type, bytes }]` on the
  owner's message. A named image that is not staged answers `invalid`: nothing is stored,
  and a conversation that was made for that message is not kept. A message that would
  pass 40 images answers `limit`.
- **The message list is the authority.** The image operation `read` answers the bytes of
  an image only when a message of that conversation names it and the file still has the
  recorded size and type. A staged image is never served.
- **What the run gets.** The prompt lists the file of each image of the conversation
  that is still there, and the IDs of the images of the newest message. The run reaches
  the files by the provider arguments of [The provider run](#the-provider-run). An
  earlier image stays readable in a later turn of the same conversation.
- **Deleted with the conversation.** **Delete** removes the folder of the conversation's
  images with its file. Nothing else removes a sent image.

### An image on a task

- **Only an image of this conversation.** An operation names an image by its ID. When
  the answer is stored, desktop main checks every named ID against the images of the
  conversation's owner messages. A proposal that names another ID is not offered: the
  message is marked `proposalUnreadable`.
- **Two ways.** `create_task` takes `images`, one to four IDs, for the new task.
  `attach_images` holds a task ID and one to four IDs, for a task that is on the board.
  Each ID appears once in a list.
- **The canonical image route.** For each image, `apply` reads the chat's file and sends
  the bytes to `POST /internal/tasks/image-add` with the repository ID, the task ID, and
  the image ID, as the Task form does ([Tasks: Images](tasks.md#images)). The task keeps
  the chat's image ID. The monitor checks the type, the size, the four-image bound, and
  that the task has not started, and answers its fixed errors.
- **The order for a new task.** Create, then each image, then `queue_add`. So a task is
  never queued before it holds its images. An image that fails stops the operation: the
  task stays, it is not queued, and the result is the fixed error with the new task's ID
  and `part: "images"`.
- **An image the task already holds is not sent again.** `attach_images` skips an ID
  that the board lists on the task, so a second proposal for the same image succeeds
  without a request.
- **The place in the text.** The text of a `create_task` may hold the marker
  `[image:<image ID>]`, as any task text may. An image without a marker is shown at the
  end of the text.
- **A copy, not a link.** The task store keeps its own copy of the bytes. Deleting the
  conversation leaves the task's image, and removing the image from the task leaves the
  conversation's.
- **A paired device may apply it.** It is a board change, and the bytes go from the
  chat's file on the desktop to the monitor on the desktop. The device sends only the
  proposal's ID.
- **The session sees it.** A session that starts for the task gets the image file, as
  for any task image ([Tasks: Starting a session](tasks.md#starting-a-session)).

## The thread

Each repository is one continuous conversation with Aril, with search. The owner sees no list of conversations and chooses none. The thread is a view over the
repository's [saved conversations](#conversations), which are stored as before, with the same files, bounds, grant follow-up mark, and follow-up
conversations. A thread that outgrows a prompt is [compacted](#compaction) into a summary that only the prompt uses: the thread, its search, and its files stay whole.

### Order

- The thread orders every message of the repository's conversations by its time, then by the creation time of its conversation, then by the ID of its conversation, then by its place in the conversation.
- So two messages with one time keep a fixed order, and a conversation's messages keep theirs.
- A grant follow-up line is a message of its conversation, and it is in the thread like any other.
- An answer, a follow-up, an Apply, and a Dismiss stay in the conversation of their message or proposal. A follow-up to an old proposal is in the thread at its own time, after later messages.

### Where a message goes

- `send` with a null conversation goes to the repository's current conversation: the most recently updated conversation that is not a grant follow-up conversation (one with no `grantFollowUps` mark), and that has room for the message and its answer (at most 198 messages) and, for a message with images, for them (a conversation holds 40).
- When none qualifies, `send` makes a new conversation, titled by its first message: that is the first message of a repository, and a rollover when the current conversation is full.
- A repository has no limit of conversations, and its thread never refuses a message for being full: a new conversation is always made.
- `send` with a conversation ID continues that conversation, as before, and a full one answers `limit`. That is the one use of `limit` for a conversation's room, and the panel never sends a conversation ID.
- A message never goes to a grant follow-up conversation. A reply to a follow-up line is written in the current conversation, and joins the thread after it.
- A new conversation takes the provider, model, and effort of the message. The thread's last run is that of its newest conversation that is not a grant follow-up conversation.
- The `runningElsewhere` rule is gone from the panel: the thread shows the turn of the repository wherever it runs, and a turn of another repository still answers `busy`.

### Reading the thread

A repository holds any number of conversations, so no read of the thread loads them all.

- The store indexes each repository once, when it is first read after the app starts, by reading its files one at a time. The index holds, for each conversation, its ID, title, provider, model, effort, creation and update times, message count, image count, the role of its last message, the time of its newest complete answer of Aril's run, the times of its oldest and newest message, and its `grantFollowUps` mark. It holds no message.
- The messages of the sixteen conversations read last stay in memory. A conversation that was saved and not yet written is read from memory; a conversation being written is read after its write.
- A page takes conversations from the one that can reach the newest message, and stops when the next one cannot reach above the oldest message of the page. A page of a long thread reads one conversation, or a few where times overlap.
- A search reads conversations one at a time, newest first, and stops once it has twenty matches and the next conversation cannot reach above the twentieth. A search with fewer matches reads every conversation, one at a time, in batches of 200 messages with a pause between them.
- The prompt's history reads pages back from the newest message until its 24,000 characters are full, or until a page reaches the position the [summary](#the-summary) ends at, at most 100 pages. The time of the newest complete answer comes from the index alone.
- A compaction reads pages back from the newest message until a page reaches that position, at most 100 pages (6,000 messages).
- The choice of the conversation for the next message, the last run, `updatedAt`, and the grant follow-up conversation come from the index alone.

`thread` takes `{ repositoryId }` and may take `before`, a cursor, and `limit`, a whole number from 1 to 60 (60 when absent). Another key, a `before` that is not a string, a cursor this module did not write, or a `limit` outside its bound answers `invalid`.

- The answer holds `messages`, `before`, `turn`, `sendTo`, `run`, `updatedAt`, and `summarized`.
- `messages` are the newest `limit` messages before the cursor (or the newest of all, with no cursor), oldest first. Each is a stored message as `read` answers it, with the ID of its conversation in `conversationId`. A message ID repeats across conversations, so a message is known by both.
- `before` is an opaque cursor for the page before the first message of this one, or null when there is none. It names the oldest message of the page it was made for, in the form this module writes; nothing else is a cursor.
- `turn` is the repository's turn in the shape `read` answers it, with its `conversationId`: the one that answers, else the oldest follow-up that waits (it reads as `starting`), else null.
- `sendTo` is the ID of the conversation the next message goes to, or null when a new one will be made.
- `run` is `{ provider, model, effort? }` of the thread's last run, or null before the first message.
- `updatedAt` is the newest update time of any conversation of the repository, or null. A client compares it with the one it read at.
- `summarized` is `{ through: { conversationId, messageId, at }, at }`, or null when the thread has no summary: where the [summary](#the-summary) ends and when it was written, in every page, and never its text.
- Like `read`, it repairs a conversation that ends on the owner's message with no run behind it by adding one answer with the status `interrupted`, but not while a send or a grant write of the repository holds the turn.
- The answer never holds a path, a `grantFollowUps` mark, or image bytes.

### Searching the thread

`search` takes `{ repositoryId, query }`. A query is trimmed text of 1 to 100 characters with no control character; anything else answers `invalid`.

- The answer is `{ ok: true, matches }`: at most 20 matches, newest first.
- A match is `{ conversationId, messageId, at, role, snippet }`. `role` is `user` or `agent`.
- A message matches when its text holds the query as a substring, whatever the case of either. The query is never read as a pattern, and no accent is folded.
- The snippet is a short plain excerpt around the first place the text matches: up to 40 characters before and 80 after, with runs of white space made single spaces and an ellipsis at each cut end. It is at most about 220 characters.
- Only the text of a message is searched: not a proposal, an image, a status, a timing, a summary, or a grant follow-up mark. A grant follow-up line is searched like any message.

## Compaction

When a repository's thread outgrows what a prompt carries, Pomegr summarizes the older part with one provider run and keeps the summary, instead of dropping those messages from the prompt. It changes only what the prompt carries: the owner's messages stay readable and searchable in full, and the conversation files are not touched. Aril settings and repository memory live outside the thread, so compaction never changes them.

### The summary

- There is one summary for each repository: `<desktop data root>/agent-chat-v1/<repository ID>/summary.json`, holding `{ version: 1, repositoryId, summary }` (`agent-chat-summary.mjs`). The conversation store lists only files whose name is a conversation ID, so it never lists this one.
- `summary` is `{ text, through, at, provider, model, effort?, timing? }`. `text` is 1 to 6,000 characters of plain text with no control character except a line break or a tab. `through` is the thread position of the newest message the text covers: `{ conversationId, messageId, at }`. `at` is when it was written. `provider`, `model`, and `effort` (always `low`) are those of the run that wrote it, and `timing` is that run's [timing](#timing).
- A record outside the contract reads as none. A `timing` outside its contract is left out of an otherwise valid record. A file of another version, for another repository, over 64 KiB, or that is no JSON reads as none and stays until a new summary is written.
- A write replaces the file whole, through a temporary file and a rename, one at a time. A write that fails changes nothing.
- `through` divides the thread by [its order](#order): a message is covered when it is not after that position. A message ID is its place in its conversation plus one, so the position stays exact when its conversation is no longer stored, which then counts as created before every other.
- A new summary replaces the old one whole and covers the old summary and the messages after it.

### When a compaction runs

- After a turn of the repository ends `complete` and is handled: an owner's message, a follow-up, or a grant write turn. A turn that fails, is stopped, or times out starts none, so a provider that is down is not asked again for a summary.
- Only when no turn of that repository runs or waits and no compaction of it runs. A compaction of one repository neither waits for nor holds a turn of another.
- It reads the thread back from the newest message as far as the summary reaches, or at most 100 pages (6,000 messages) without one. The prompt's history holds the newest messages that fit `HISTORY_BUDGET` (24,000 characters); the older messages are the rest that come after the summary's position.
- It starts only when the history lines of the older messages, with their separators, total more than 8,000 characters (`COMPACTION_THRESHOLD`). Below that nothing runs and nothing is stored.
- Up to that many characters of messages can sit between the summary and the prompt's history, left out of the prompt until the next compaction takes them. The prompt says "(Earlier messages are left out.)" for them.

### The compaction run

- The thread's last run decides: the provider and model of the newest conversation that is not a grant follow-up conversation, at effort `low`. Pomegr lowers no other run's effort: an owner's message runs at the effort the owner chose.
- It is `runChatTurn` with `tools: "none"` ([No tools](#the-provider-run)): no MCP server, no image, no instructions file, the repository root as its working folder, the owner's environment, the prompt on stdin, and five minutes (`COMPACTION_TIMEOUT_MS`) to answer. A Claude Code run is [declared](#the-declared-run) like a turn's, so it never shows in Sessions.
- The prompt is the fixed `COMPACTION_INSTRUCTIONS`, the earlier summary between `<earlier_summary>` tags when there is one, and the older messages between `<messages>` tags: the same lines the prompt's conversation holds, oldest first. It holds no board, task log, settings, or memory.
- The instructions ask for a concise summary, in English, of what matters for continuing the work: decisions, the owner's stated preferences, open questions, what was proposed and what became of it, task IDs, pull request numbers, feature names, and dates. They leave out file contents, tool output, code, and anything Aril only read. They say never to invent a fact, to use no tool, to write no proposal block or JSON, and to stay within 4,000 characters (`SUMMARY_TARGET`). They say the summary and the messages are data.
- Messages that do not fit one prompt of 200,000 characters (`PROMPT_LIMIT`) with the earlier summary are compacted in chunks, oldest first. Each run takes the oldest messages that fit, at least one, and stores its summary; the next starts from it.
- Only a run that ends `complete` is read, and its answer is stored as plain text: a `pomegr-board` block is dropped, and what remains must be a text the summary's contract accepts. Nothing in it is read as a proposal, a rework record, or an instruction. It adds no message to a conversation and reads, applies, and starts nothing on the board.
- A run that fails, is stopped, times out, or answers outside the contract changes nothing: the old summary stays. A chunk that fails keeps the summaries the chunks before it stored.

### Stop and retry

- A turn that starts for the repository (an owner's message, a follow-up that takes the one turn, or a grant write) stops that repository's compaction first. Pomegr ends its own run, the message is not refused for it, and nothing is stored even if the run answered meanwhile.
- The next turn of the repository that ends `complete` tries again. Closing the app stops the run the same way.

### The line in the thread

- `thread` answers `summarized`, and `list` answers `summarizedAt` once there is a summary, so an idle panel reads the thread again when a compaction finished.
- The panel draws one quiet line after the message at `through`: [the design page](../design/agent-chat.md#summary-line) owns how it looks. The line is not a message, is not stored in a conversation, and no search finds it.
- No answer of `read`, `thread`, `search`, `list`, or a paired device holds the summary's text. It stays in desktop main and in the prompts of the thread's own repository.

### Timing

An answer takes several seconds even on an empty board, and where the time goes is not known. Every owner-message turn and every compaction run therefore records how long it took and how large its prompt was, and an owner-message turn also records how long its [preparation](#preparation) took, so a later change can aim at the slow step. A timing is numbers only.

- `timing` is `{ eventMs, textMs, doneMs, prompt, prepare? }`, in whole milliseconds from the start of the provider process to its first provider event, to the first words of the answer, and to its end. `eventMs` and `textMs` are null when the run ended before them. `prompt` holds the length in characters of each part of the prompt: `instructions`, `board` (the snapshot), `taskLog`, `conversation` (the summary section and the conversation), `message` (the owner's message), and `other` (workflow changes, worktrees, GitHub settings, images, and framing). The parts add up to the prompt, with the instructions counted even when Claude Code reads them from its file. A compaction run has no board, task log, or message, so those are 0, and its `conversation` is the earlier summary and the messages.
- `prepare` is the [preparation](#preparation) of an owner's message, in whole milliseconds by step. A compaction run has none, and a timing may have none.
- `runChatTurn` measures with a monotonic clock and answers `timing()` once the run ended, or null before the process started. The outcome of the run keeps its shape. The preparation is measured by desktop main with the same kind of clock, before the process starts.
- It is stored on the answer of an owner's message, whatever its status, and on the summary record, from the run that wrote that summary. A follow-up, a grant write turn, and a grant follow-up line store none.
- Every time is 0 to 3,600,000 and every part 0 to 1,000,000, as whole numbers, with the first event not after the first words and neither after the end. The writer cuts a measured number to those bounds, and a run that measured nothing usable stores no timing. A stored `timing` outside the contract is left out when the record is read, and the message or summary is kept. A record without one, as an older version wrote, stays valid. A `prepare` outside its contract (a name that is no step, a step longer than `total`, no `total`, or a value that is no whole number in range) is left out alone: the run's numbers stay. A timing without `prepare`, as an older version wrote, stays valid.
- The panel adds it to the tooltip of the answer's time. The preparation is one line above the run's numbers, such as "Prepared in 3.2s (slowest: GitHub 2.9s)", and names the slowest step only when it took a tenth of a second or more. No console line, log, notification, or monitor request carries a timing. It is Pomegr's own clock around a process it started, not an authoritative measurement of the provider.
- The first timings of real answers showed that the first event came within seconds while the first words took far longer, with prompts that had grown past 100,000 characters on a large board. Two changes followed on 2026-10-29: the activity label says `Starting…` only until the first event, and the prompt was made smaller (see [Prompt](#prompt)). The timings are to be read again after the owner has used them.

### Preparation

A real answer on 2026-10-29 showed the owner's message saved 20 to 80 seconds after the panel drew it, while the provider itself answered in 24 seconds. The reads before the process were awaited one after another and none of that time was measured. They now begin together, and each is timed.

- An owner-message turn begins every read at once, after the refusals that need none of them (`busy`, `cli_missing`, `not_found`, `limit`). The board, the repository root, the observed runs, the task log, the thread's facts, the instructions file (Claude Code only), and the run's environment need nothing else. The GitHub settings need the root. The workflow changes and the worktree facts need the root and the board. Nothing waits for a read it does not need.
- The prompt waits for the slowest read. The refusals keep their order: a board that is not ready, or no root, answers `unavailable` as soon as those two have answered; then the conversation is made, then an image that cannot be claimed answers `invalid` and the conversation made for the message is removed, then a prompt past its limit answers `invalid` and removes it again, then a message that cannot be saved answers `unavailable` and removes it. Closing the app while the reads run answers `unavailable` and removes it. A read that fails or times out leaves its section out as before and refuses nothing. A read that a refused message did not wait for finishes unseen.
- The run's declaration to the monitor, the opening of the task bridge, and the environment (begun with the other reads) are awaited together after the message is stored, then the process starts. A follow-up and a grant write turn begin the reads they need together in the same way.
- Each step times itself with a monotonic clock, from when it began to when it answered, and `total` runs from the moment `send` is entered to the call that starts the process. The steps run side by side, so they do not add up to `total`, and a step that waited for the root or the board counts only its own work.
- `prepare` holds the steps this turn ran, in this order: `board`, `root`, `runs`, `taskLog`, `github`, `workflow`, `worktrees`, `instructions`, `context` (the repository's last completed answer, the summary, and the thread's newest messages), `environment`, `store` (making the conversation, claiming its images, and saving the message, added up), `declare`, `server` (the task bridge), and `total`. `github` is absent when no reader is given, and `instructions` for Codex. Every value is a whole number of milliseconds, from 0 to 3,600,000, and no step is longer than `total`.
- A follow-up, a grant write turn, and a grant follow-up line store none, as they store no timing.
- The preparation itself keeps nothing between messages. The GitHub reader already keeps its answer in memory for 30 minutes, and for 5 when the read failed (see [Repository GitHub settings](tasks.md#repository-github-settings)), and the facts of the task worktrees have a cache of their own (see [Task worktree facts](#task-worktree-facts)). The workflow changes keep what Git told them while a key made of the files says nothing changed (see [Workflow changes](#workflow-changes)): the workflow rule asks Aril to ask again when a source changed, and a source the owner edited a minute ago must show on the next turn.

### Task worktree facts

A real answer on 2026-10-29 spent 9,806 of the 10,674 milliseconds of its preparation on the `worktrees` step. Before every message, the listing read two Git processes for each worktree one after another, then walked the size of each folder under a budget of 6 seconds. Its facts now live in `agent-chat-worktrees.mjs`, in desktop main's memory, and a turn does not wait for any of it. On 2026-10-29 the first message after the app started still stored 7,186 ms for the step, because a repository with no cache read its Git facts (14 worktrees) and waited for them. It no longer does.

- **What it keeps.** For each repository ID: the rows `{ taskId, clean, uniqueCommits, sizeMB, atLeast }` that `task-worktree.mjs` answers (`inventory` for the Git facts, `sizes` for the folder walks), and the time its Git facts were read. Never a path, a file name, or Git output. Nothing is written to disk, so a restart starts with no cache. The task's `state` and `column` are not kept: every read joins the board of that turn, because a task that has just moved to Done is the reason to propose a removal.
- **A turn with a cache** uses the rows at once and calls neither Git nor a folder walk. Its `worktrees` step is then about 0 milliseconds.
- **A turn with no cache** starts the one read of the repository in the background and goes on at once, with no rows: `rows` is null, which is not the same as no worktrees. The prompt says so in one sentence (see below), so Aril does not claim there are none. The read is the Git facts, two processes for each worktree and three worktrees at a time, and then the folder walks; the next turn finds the rows, with `unknown` for a size no walk has measured yet. When the Git facts cannot be read, nothing is kept and the next turn starts the read again.
- **Read after start.** Desktop main asks for it once, 10 seconds after it starts (`prefetchWorktreeFacts`; the chat controller option `prefetchWorktrees`, which only the desktop shell sets), so that the first message finds the rows. It lists the repositories that have a Pomegr board from the monitor's Tasks home (`GET /api/tasks?view=home`, with the desktop token), asks for each repository root (`POST /internal/tasks/worktree-root`), and reads the facts of one repository at a time, so that many boards do not start many Git processes together. A repository whose root the monitor had not located yet is tried again at 60 seconds; a repository the prefetch never reaches is read by its first turn, which waits for nothing either. The timers do not keep the process alive, and closing the app cancels them. Nothing new crosses a boundary: the same two monitor reads and the same Git calls.
- **An old cache.** A cache older than 3 minutes, or one that a change made out of date, is read again in the background, and the turn that found it uses the old rows without waiting. One refresh runs for a repository at a time, until its walks end. A refresh that has run for a minute is given up on and its late answer is dropped, so a folder walk that hangs cannot stop later refreshes. A row keeps its last known size until a walk measures it again. A refresh that fails keeps the last rows and is tried again by the next turn.
- **What makes it out of date.** A worktree made by a task start, and a worktree removed or found missing, whoever did it: the removal of Mark done and of the queue runner share the desktop's one `createTaskWorktrees` with the chat. Every Apply of a removal proposal, whatever its result, does too; a removed task's row leaves the rows at once, and any other result means the cached facts had moved.
- **What a stale row cannot do.** The rows only inform Aril. A removal never reads them (see [Worktree removal](#worktree-removal)): `remove` of `task-worktree.mjs` reads the live Git listing, the working tree, and the commits again and keeps the worktree when any of them says it is not safe. The worst a stale row does is a proposal that Apply answers with `dirty` or `unique_commits`.
- **What the prompt says.** While the rows are not known, the section is the one sentence "Task worktree facts are still being read, so do not say there are none." Otherwise it tells Aril when the Git facts were read, that they may be a few minutes old, that a size can be unknown or older, and that Pomegr reads a worktree again when the owner applies its removal.

## Conversations

Desktop main keeps one JSON file per conversation:
`<desktop data root>/agent-chat-v1/<repository ID>/<conversation ID>.json`, holding
`{ version: 1, repositoryId, conversation }`.

- A conversation has an ID (`chat-<12 hex>`), a title (the first line of the first
  message, at most 80 characters), the provider, model, and effort last used, two times, and its
  messages.
- An answer of Aril stores the provider, the model, and the effort it ran with. The effort is one of
  `low`, `medium`, `high`, and `xhigh`, and the field is absent when there is none. A record
  without it, such as one an older version wrote, reads as null; a value that is not one of the
  four makes the store refuse the record, as it does for a model outside the contract.
- Bounds: 200 messages for each conversation, 4,000
  characters for a message of the owner, and 32,000 for an answer. A repository holds any number of conversations.
  A named conversation that is full answers `limit`.
- Desktop main keeps an index of each repository's conversations in memory (see [Reading the thread](#reading-the-thread)) and the messages of the sixteen read last. Every other message stays in its file until a read asks for it.
- A message of the owner may list its images as `{ id, type, bytes }`. The file never
  holds image bytes or a path: the images are files of their own (see [Images](#images)).
- An answer of Aril to an owner's message may hold `timing`, the numbers of its run (see [Timing](#timing)). A record without it is valid.
- An answer of Aril may hold `choices`, its quick replies or one question (see [Choices](#choices)), or `choicesUnreadable: true` for a block that could not be read. A record without either is valid.
- An answer of Aril may hold `followUp`, the ID of the proposal it follows up (see
  [Follow-up](#follow-up)). Such an answer has no message of the owner before it.
- A grant follow-up is an answer with `grantFollowUp: true` and no proposal (see
  [Grant follow-ups](#grant-follow-ups)). Its conversation holds `grantFollowUps`, the mark
  of the last follow-up written, which a read never answers.
- A write replaces the file whole, through a temporary file and a rename.
- A file outside the contract, of another version, or over the size bound is never
  listed and never overwritten.
- The repository's [summary](#the-summary) is one more file in the repository's folder. `delete` does not rewrite it, so a summary can outlive the conversation it was made from.
- Nothing deletes a conversation except `delete`, which also removes the folder of its images. The panel no longer offers it:
  the owner sees one thread, and no client calls `delete`. Storage
  retention and the prune cycle of the observation store do not touch this directory.
- A conversation that ends on the owner's message with no run behind it lost its answer:
  the app closed during the turn. The next read adds one answer with the status
  `interrupted`.

## Boundaries

Aril may record a rework link (references and a cause from a fixed list) without Apply; it changes no task.

| Surface | Who | What it carries |
| --- | --- | --- |
| `pomegr:agent-chat` IPC | The renderer, through a trusted main frame only | One fixed operation and a payload of at most 17 KiB; answers the chat's own bounded answer, `thread` and `search` included. The only surface whose `apply` can start a session or remove a worktree |
| `pomegr:agent-chat-image` IPC | The renderer, through a trusted main frame only | One of the fixed operations `add` and `read`. `add`: a repository ID and the image bytes (a `Uint8Array` of at most 5 MiB); answers the image's ID, type, and size. `read`: a repository ID, a conversation ID, and an image ID; answers the type and the bytes. No answer carries a path |
| `POST /api/agent-chat/image-add` and `GET /api/agent-chat/image-read` on the LAN gateway | A paired device only | The same two operations, answered in desktop main and never forwarded. `image-add` takes the bytes as an `application/octet-stream` body of at most 5 MiB with the repository ID as its only query key. `image-read` takes the repository ID, the conversation ID, and the image ID as its only query keys, and answers the bytes with one of the four media types, `no-store` |
| `POST /api/agent-chat` on the LAN gateway | A paired device only | `{ operation, payload }` with the same operations and bound, `thread` and `search` included; the gateway answers it in desktop main and never forwards it. Its `apply` of a session start, a worktree removal, or a feature edit answers `desktop_only`. Its `apply` of a queue change is accepted |
| The manual start in desktop main (`createTaskStart().startApproved`) | Desktop main, for an approved start proposal of the desktop window | The window event, the repository ID, and the task ID in; one fixed start status out. No prompt, plan, path, or token reaches the chat |
| Git in desktop main (`createTaskWorktrees`) | Desktop main | `worktree list`, `status`, `rev-list`, `worktree remove`, and, under the branch rule, `branch -D`, as argument arrays with no shell, for the facts of the worktree rows (read in the background, never during a turn) and for an approved removal. The folder walk of the sizes follows no link. The prompt gets facts and result words only; no output, path, or error text |
| `GET /api/tasks` and `POST /internal/tasks/worktree-root` on the monitor | Desktop main, with the desktop token | The board for the prompt and for an apply; the repository root for the run's working directory |
| `POST /internal/tasks/log-read` and `log-ack` on the monitor | Desktop main, with the desktop token | The newest 100 log entries for owner-message prompts; acknowledgement through the highest shown ID after a complete turn |
| `POST /internal/tasks/aril-declare-rework` on the monitor | Desktop main with desktop token; no browser Origin, LAN-gateway marker, or MCP capability | Exactly `{ repositoryId, fix, reworks, cause }`; fixed status or error; no renderer, paired-device, or MCP route |
| `POST /internal/tasks/<action>` on the monitor | Desktop main, with the desktop token | One of `create`, `update`, `delete`, `move`, `feature_create`, `queue_add`, `queue_remove`, `queue_group`, `queue_ungroup`, and `after_set`, for an approved proposal of board changes; `queue_settings` with exactly `{ on }`, for an approved queue proposal |
| `POST /internal/tasks/image-add` on the monitor | Desktop main, with the desktop token | The bytes of one image the owner sent in the conversation, with the repository ID, the task ID, and the image ID in the query, for an approved proposal that names the image |
| The provider run | Desktop main | The prompt on stdin, with Claude's fixed instructions optionally in its desktop-owned system-prompt file; JSON lines on stdout |
| The compaction run | Desktop main | The same kind of run with `tools: "none"`: a compaction prompt on stdin and the plain-text summary on stdout, after a complete turn and never while a turn of its repository runs ([Compaction](#compaction)) |
| Read-only `git log -1` and `git status --porcelain` in the repository root | Desktop main | One call per workflow source and one for the set, started with an argument array and no shell, within 5 seconds in total, and not at all while the kept facts' key is unchanged ([Workflow changes](#workflow-changes)); only repository-relative names and dates are kept. The key is read from `.git` files, never sent anywhere |

The operations and their payloads, each with `repositoryId`:

| Operation | Other keys | Answer on success |
| --- | --- | --- |
| `list` | none | The newest 50 conversations (ID, title, update time, message count), the conversation being answered or null, and `summarizedAt` once the thread has a summary. The 50 bound an answer and not a repository. The panel asks it only to learn that something changed |
| `read` | `conversationId` | The conversation (an answer's `timing` included) and the running `turn` or null |
| `thread` | optional `before` (a cursor) and `limit` (1 to 60) | The newest page of the thread, a `turn`, `sendTo`, `run`, `updatedAt`, and `summarized`: see [Reading the thread](#reading-the-thread) |
| `search` | `query` (1 to 100 characters) | At most 20 matches of the thread's text, newest first: see [Searching the thread](#searching-the-thread) |
| `send` | `conversationId` or null (the panel sends null), `text`, `provider`, `model` or null; optional `effort` (`low`, `medium`, `high`, `xhigh`, or null), optional `images`, one to four IDs of images added with the image operation `add` | The conversation ID |
| `stop` | `conversationId` | Nothing more |
| `apply`, `dismiss` | `conversationId`, `proposalId` | Nothing more; the client reads the conversation again, and that read may answer the `turn` of the follow-up. An `apply` of a session start also answers success when the start was held, failed, or cancelled: the stored proposal says which. An `apply` of a queue change also answers success when the monitor refused it or did not answer. An `apply` of a worktree removal answers success once each removal was tried, whatever its result |
| `delete` | `conversationId` | Nothing more. No client calls it |

A refusal is `{ ok: false, error }` with one of `invalid`, `not_found`, `busy`, `limit`,
`cli_missing`, `conflict`, `unavailable`, and `desktop_only`. A payload with another key
is `invalid`. `desktop_only` answers only the `apply` of a session start, a worktree
removal, or a feature edit that did not come from the desktop window, and of settings or
memory while `pairedDevices` is not true.

- An image operation refuses with `{ ok: false, error }` and one of `invalid`,
  `not_found`, and `unavailable`. The two paired-device image routes take a request
  under the checks of the task image routes ([Tasks: Paired devices](tasks.md#paired-devices)):
  the session cookie, the gateway's own `Origin` and a declared length for the POST, the
  exact query keys, and no body for the GET.
- The paired-device route takes the POST only with the session cookie, the gateway's own
  `Origin`, a JSON content type, no query, and a declared body of at most 17 KiB, like
  the task-action route. A same-computer browser and the development server have no chat
  route, so the panel is not drawn there.
- The preload exposes `agentChat(operation, payload)`. It refuses an unknown operation
  or a payload without a repository ID before any call. It exposes
  `agentChatImage(operation, payload)` too, and refuses a payload outside the exact shape
  of `add` or `read`.
- A `turn` carries the conversation ID, the start time, the provider, the model, the effort when
  there is one, the answer text so far, and one activity: `starting`, `thinking`, `reading_files`,
  `reading_sessions`, `reading_usage`, or `writing`. The label is chosen from the tool's
  name. No tool input, tool result, or provider error text is read into an answer.
  `starting` covers only the time until the provider process writes its first event: Claude Code's `system` init line or Codex's
  `thread.started` line, which the runner reads as the first event of any kind. From then on the activity is `thinking` until
  a tool, text, or other block changes it. A follow-up that waits behind another turn stays `starting`.
  The first event is the same moment that the run's [timing](#timing) records as `eventMs`.

## Privacy

Aril may record a rework link (references and a cause from a fixed list) without Apply; it changes no task.

- The snapshot sends task rework references and fixed causes, target markers, Done counts, and a 30-day cause and run summary. Individual link times and declarers stay out of it.
- Only validated references and a fixed cause leave an answer for the monitor; it supplies declarer `aril` and the time. No answer text is sent.
- Fixed recording or refusal lines stay in the chat conversation and cross its existing desktop and paired-device read boundaries. The task log records kind `rework` through its existing paths.

The conversation is a new data class: text the owner wrote and text the agent wrote. It
is the one place where Pomegr shows a prompt and a response, and they are the chat's own,
never a session's.

- **The thread and the search.** `thread` and `search` answer only what `read` of the same conversations answers, in pages and excerpts: the stored messages with their proposals and the IDs, types, and sizes of their images (never the bytes), the turn, the ID of the conversation the next message goes to, the provider, model, and effort of the last run, the newest update time, an opaque cursor, and plain excerpts of message text. They go to the trusted renderer through `pomegr:agent-chat` and to a paired device through `POST /api/agent-chat`, as `read` does. No GET serves them. A query is held in memory while it is answered and by the panel while it is open: nothing keeps it, logs it, sends it to the monitor or a provider, or writes it to browser storage. A search is a plain substring match, so the owner's text is never read as a pattern. Desktop main holds in memory an index of each repository's conversations (titles, counts, and times, with no message) and the messages of sixteen conversations; nothing else of a conversation is in memory.
- **The summary.** It is derived from the owner's own conversation: text that Aril wrote about what the owner and it said. It lives in desktop main's memory and in `summary.json` in the repository's chat folder under the desktop data root, and nowhere else: not in the monitor, the task store, the observation store, a checkpoint, a report, a log, a notification, diagnostics, or browser storage. It reaches only the provider the thread last ran with, in that repository's own runs: the compaction run that writes the next one and the prompts that carry it. It is never returned to the browser or to a paired device as text: `thread` answers where it ends and when it was written, and `list` answers when it was written. Another repository never receives it. The instructions tell the run to leave out file contents, tool output, code, and anything Aril only read; that is an instruction and not a filter, so the summary can hold what Aril concluded from them. Deleting a conversation does not rewrite it.
- **A run with no owner action behind it.** A compaction is a provider run that Pomegr starts after a complete turn, with no message and no Apply of the owner, and it spends the owner's provider allowance. It sends the provider the older messages and the earlier summary, which a prompt already sends in part, and no board, task log, settings, memory, image, or path. It has no tool and no MCP server, cannot propose, apply, or start anything, and Pomegr stops it when a turn of its repository starts. This is the widening of 2026-10-28 (Aril agent plan, phase 1): before it, only an owner's message, an Apply, or a Dismiss started a run.
- **Choices are the chat's own text.** Quick replies and the question with its options are text that Aril wrote for the owner, of the same data class as its answer. They are stored in the conversation file, returned by `read` and `thread` to the trusted renderer and to a paired device as the answer text is, and sent to the provider in later prompts as one history line (the replies, or the question and the option labels). A tap is the owner's own message and travels as any message does. Nothing keeps a choice anywhere else: not the monitor, the task store, a log, a notification, diagnostics, or browser storage. `choicesUnreadable` is one boolean. This widens no exposure beyond the conversation, and no choice adds a route, an operation, or an authority.
- **Timing is numbers.** A timing holds whole milliseconds, prompt lengths in characters, and the milliseconds of each preparation step under a fixed step name, and no text, path, name, or ID. It is stored with the answer or the summary it belongs to, shown only in the tooltip of an answer's time, and crosses the same two boundaries as the answer: the trusted renderer and a paired device. Nothing logs it or sends it to the monitor or a provider.
- **The effort is a fixed word.** One of four levels, stored in the conversation file on the
  conversation and on each answer, shown in the panel, and sent to the provider only as a
  validated argument of the run. It is never taken from text, and it adds no path to the
  browser, the monitor, a log, or a notification.

- **Images are part of it.** An image the owner sends is the owner's own content, of the
  same data class as the message it belongs to. It is kept as a file under the chat's
  directory, and a conversation file lists only its ID, type, and size.
- **Where it lives.** In the conversation files and the image files under the desktop
  data root, and in desktop main's memory. Not in the monitor, the task store, the observation store, a
  checkpoint, a report, a log, a notification, or diagnostics.
- **Grant follow-ups.** A grant follow-up's line holds only task IDs, provider names, and
  fixed words, built from task-log facts. Its notification carries those facts, the
  repository ID, and the conversation and message IDs, never chat text
  ([Notification privacy](privacy/notifications.md#aril-follow-ups)).
- **Fixed instructions file.** Desktop main also writes `<desktop data root>/agent-chat-v1/instructions-<sha256>.md` for Claude; it contains only the fixed `AGENT_CHAT_INSTRUCTIONS`, with no owner, conversation, board, image, or credential data. Codex keeps the instructions first in stdin.
- **Who gets it.** The trusted renderer through `pomegr:agent-chat`, and a paired device
  through `POST /api/agent-chat`. No GET serves it, except the one GET that answers a
  paired device the bytes of an image of a conversation. A same-computer browser gets nothing.
  Image bytes cross only the `pomegr:agent-chat-image` channel and the two paired-device
  image routes. The renderer draws an image from an object URL of its own page and
  revokes it when the panel leaves.
  The renderer keeps it in memory only; browser storage holds only the ID of the
  repository chosen last.
- **What reaches the provider.** Each turn sends the prompt to the provider the owner
  chose, through the owner's CLI. Its conversation section holds the newest earlier messages of the repository's thread, from every conversation, in the same bound of 24,000 characters and as the same kinds of line, preceded by the thread's summary when it has one (see [The summary](#the-summary) above): text the owner and Aril wrote in the chat, and grant follow-up lines, which the prompt held before only when the owner replied in their own conversation. From 2026-10-25 (Aril operator phase 1), an owner-message prompt also holds unseen task-log entries.
  These entries carry only task IDs, fixed kinds, times, and pull-request numbers; no text. A grant usage pause or resume has no task ID and carries only the fixed provider ID.
  The cursor moves only after a complete turn. Follow-ups neither read nor acknowledge the log.
  From 2026-10-25 (Aril operator phase 2), the board snapshot also sends the latest review verdict, its time, and its one-line reasons (written by a reviewer session) for a task in Review, never the reviewer session ID.
  From 2026-10-25 (Aril operator phase 3), the prompt sends the current Aril settings, including read-only `pairedDevices`, and repository memory IDs and text, oldest first, up to 100 entries of 300 characters each.
  From 2026-10-25 (Aril operator phase 4), it also sends the current grant's active state, end time, tasks used, and snapshotted limits and actions; an ended grant adds its fixed end reason. Aril uses these existing settings and grant facts to determine whether an active grant permits a send-back or merge. The owner-set merge method is part of the settings sent with the board; merge outcomes are reported from fixed `grant_merge` and `grant_merge_refused` log entries.
  From 2026-10-25 (Aril operator phase 9d), the prompt also sends the time the settings were last saved, each memory entry's last update time, and, once something is settled, the [workflow changes](#workflow-changes): the repository-relative names of changed workflow sources (the fixed list and the files under `.github/workflows/`) with a commit or last-edit date and whether they are uncommitted. It sends no file content, no absolute path, and no Git output beyond those names and dates; a Git failure sends only "Workflow changes are unknown." The provider run can read those files itself, as it can read any file of the repository.
  From 2026-10-25 (Aril operator phase 9b), an owner-message prompt also holds the repository's five GitHub merge-setting booleans and its default branch name, or `unknown`. Desktop main reads them with `gh repo view` and the owner's own gh login and keeps them in memory (30 minutes; a failed read 5); nothing else of the `gh` answer is kept or sent.
  Feature rows also include their IDs so Aril can select existing features in work rules. Applied settings and memory operations reach the follow-up as operation names, memory IDs where applicable, and fixed outcomes.
  A follow-up is a turn: an Apply or a Dismiss sends one
  prompt to the provider the conversation used last, with no message of the owner. This
  is the widening of 2026-10-13 (task T-95): until then only a message started a run.
  The prompt of a follow-up holds the conversation, board snapshot, images, and the outcome record: the
  proposal's summary, the operation names, the task IDs, a feature title and a column
  name the proposal wrote, and fixed result words. It holds no task text beyond the
  snapshot's, no path, and no error text. If the owner answers an eligible follow-up
  proposal, the next outcome record includes that stored proposal in the same form. That
  prompt holds the owner's messages, Aril's earlier answers, and the board snapshot: task
  text, own conditions, feature titles, block
  reasons, attention lines, session references, model names, provider-reported observed effort labels bounded by the [task contract](tasks.md), the task IDs each task
  runs after (task T-101), and each card's position in its column (task T-103). The model
  names include the models the task form offers: Claude's newest observed model of each
  family, from the sessions of every repository in the last 90 days, and the Codex
  catalog (task T-110). A model name carries no session, path, or repository. This is a deliberate
  widening: before the chat, a task's text reached a provider only in the prompt of its
  own session. The run can also read the repository's files and call the seven observation
  tools and the repository-bound `get_task` and `list_tasks`, so file content and normalized session evidence can reach the provider in the
  same run, as they can in any session the owner starts in that folder. The images the
  owner sent in the conversation reach the provider too: the run reads their files. This
  is the widening of 2026-10-13 (task T-86). The prompt names the absolute file of each
  image, so the path of the chat's image folder under the desktop data root, which holds
  the user's folder name, reaches the provider. A task's session has had the path of its
  task's image folder in the same way.
  From 2026-10-25 (Aril operator phase 9c), an owner-message or grant-write prompt also sends the facts of the Pomegr task worktrees that remain: the task ID, the task's state and column or "not on board", whether the tree is clean, whether HEAD holds a commit that exists nowhere else, an approximate size in MB or "unknown", and the time the Git facts were read. Never a path, a file name, or Git output. The facts are kept in desktop main's memory between turns and never written.
  A grant write turn sends the normal board snapshot, repository settings and memory,
  workflow changes, task log, and the grant's named plan paths. Its fixed request asks Aril to read the
  next unbuilt step of an accepted plan and create 1–5 tasks with only `text`,
  `complete_when`, `own_condition`, and `runs_after`. It uses no follow-up proposal.
- **Native file access.** The owner-approved native read surface can include files outside the selected repository, subject to provider permissions.
  Pomegr does not filter source filenames or inspect source contents before the provider reads them.
  Instructions prohibit reading credentials and private session transcripts; this instruction is not a filesystem enforcement boundary.
  Native tool results can reach the chosen provider. Pomegr drops tool results and keeps only the conversation answer under the existing rules.
- **Compact snapshot boundary.** Full task fields cross only for active, recent, and connected cards under the selection rule above. Other non-Done cards send only index lines; Done cards contribute aggregate counts and ten recent index lines, and a Done card with a full entry sends its run, results, and title line, not its conditions or body. The saved completion time is used locally, with no new persistent marker or provider field.
- **What the task read exposes.** `get_task` can send the full text omitted by the snapshot's shared budget to the same chat provider, with the T-118 task fields and only the snapshot's attention and block lines added. It exposes no path, credential, capability, repository ID, column ID, feature ID, session, image, dispatch fact, feature description, or app version. `list_tasks` sends the existing coding-session list projection (at most 100 rows and 300 characters of text each, with matched/truncated counts) to the same provider; it adds no attention or block lines. Both monitor and MCP worker apply the shared allowlist. It writes nothing. The snapshot keeps its 5,000-unit text bound and its 20,000-character size bound under the rules above; shortening a value or leaving one out narrows what crosses, and the snapshot adds no value.
- **What never enters a prompt.** Credentials, tokens, the desktop token, a path other
  than the grant's named plan paths, the working directory the process starts in, and the files of the conversation's
  images, the images of a task, an image of another conversation, and the description or
  app version of a feature. A repository ID and a conversation ID enter it only as parts
  of an image's file.
- **What Pomegr keeps of the run.** The final answer text and the status. Tool calls,
  tool results, reasoning, usage, cost, and provider errors are read past and dropped.
  The provider's stderr is not read.
- **What an image on a task sends.** An approved proposal sends the bytes of the named
  images from the chat's files to the monitor on the same computer, with the desktop
  token, and nowhere else. The task store then keeps its own copy under
  [Tasks: Privacy](tasks.md#privacy). The stored result of the operation holds a fixed
  error and never a path, a file name, or image content.
- **What Pomegr keeps of a session start.** The task ID of the proposal and one fixed
  start status, in the conversation file. Nothing of the start plan reaches the chat: no
  prompt, repository root, worktree path, image file, dispatch token, or launcher output.
  A paired device that reads the conversation sees that status like the rest of it.
- **What Pomegr keeps of a follow-up.** The answer text, the status, and the ID of the
  proposal it follows, in the conversation file. A valid eligible follow-up may also
  store one validated board-change proposal in the same conversation record. A rejected
  block is removed and leaves only `proposalUnreadable`; the block text is not stored.
  The outcome record is built for the prompt from the stored proposal and is not kept by
  itself.
- **What Pomegr keeps of a worktree removal.** The task IDs, the `branch` booleans, and one
  fixed result word for each, in the conversation file. No path, size, Git output, or error
  text; the listing of a turn is built for the prompt and is not kept.
- **What Pomegr keeps of a queue change.** The state the proposal asked for and one
  fixed result, in the conversation file: `on`, `blocked`, `off`, or a fixed error. No
  task ID, blocker, pause reason, gate reading, or board content is kept with it, and
  the action sends the monitor only `{ on }`.
- **What Pomegr keeps of a grant write.** The conversation title is `Grant: tasks from <first filename>`. Its proposal has `appliedBy: "grant"`, summary `Applied by grant.`, and state `applied`; existing operation results hold created task IDs or one fixed refusal. Desktop maps `not_active` and `not_allowed` to the existing `conflict` refusal. The grant endpoint receives only the first named plan path and validated task text, completion conditions, and dependencies; it receives no conversation, raw answer, or tool content. Created task text is kept and served under the task-board privacy rules; plan content enters no log or observation state.
- **Paired devices.** The gateway serves plain HTTP on the local network, so the
  conversation and the session cookie cross it unencrypted, as task content does.
  Whoever holds a paired device's cookie can read the conversations, send a message
  (which spends the owner's provider allowance in a read-only run), add an image, read
  the images of a conversation, and apply a proposal of board changes or a queue change.
  An Apply or a Dismiss from the device starts the follow-up run as one from the desktop
  does, so it spends that allowance too, as a message already can.
  Image bytes cross the local network unencrypted too. It cannot apply a session start or a worktree removal from
  the chat. Applying a queue change that turns the queue on lets the desktop start the
  queued tasks, which the same holder can already do through `POST /api/tasks/action`
  ([Tasks: Paired devices](tasks.md#paired-devices)). The card's Primary is an
  owner-facing boundary, not proof against a holder of the cookie. Revoking
  phone access ends this at once. The product owner asked for the
  chat on a paired device on 2026-10-11, and for the queue change there on 2026-10-12
  (task T-75), and accepts this as part of phone access.
- **Fixed answers.** A refusal is one fixed word. No answer carries a path, a command,
  a token, or error text.
- **The declared run.** A declaration holds one session ID that desktop main made for
  the run, and its expiry. It holds no path, no token, no repository, no conversation,
  and no text. Desktop main sends it only to the monitor on the same computer, with the
  desktop token, as a query value with no body. The monitor keeps it in memory, at most
  eight at a time, until it is withdrawn or expires. No durable store, checkpoint, log,
  report, or diagnostics holds it, and no browser or paired device can reach the route.

## Invariants and failure behavior

- Observation is unchanged for every session. No chat run is observed: a declared run's
  registry entry is dropped before any pipeline stage reads it (see
  [The declared run](#the-declared-run)), and no pipeline stage reads a conversation.
- Aril never changes the board itself, except through the fixed grant actions while a grant
  the owner started is active. Otherwise only `apply` does, on the owner's answer, through
  the fixed task actions. An active grant permits fixed starts, reviews, send-backs,
  eligible pull-request merges, and task writes from its named plans in
  [Aril grants](tasks.md#aril-grants).
- A grant write turn uses the plan paths snapshotted at grant start and the fixed
  `create_task` request. It writes only through `POST /internal/tasks/grant-write-tasks`.
  It creates Ready tasks within the grant cap, with no owner Apply. It runs
  only when the chat is free and starts no follow-up.
- Aril puts no image on a task. Only `apply` does, with an image the owner sent in the
  same conversation, through the monitor's own image route and under its bounds.
- A proposal that names an image the conversation does not hold is never offered.
- The thread adds no content kind: it shows, searches, and sends to the provider messages that are already stored, in pages and excerpts of the same bounds.
- A compaction changes no conversation, adds no message, and runs with no tool: one at a time for a repository, never while a turn of that repository runs, and stopped when one starts. It reads, proposes, applies, and starts nothing on the board.
- Only a complete compaction run whose answer fits the summary's contract replaces the summary. A failed, stopped, or refused run leaves the old one, and a message that arrives never waits for a compaction.
- No answer of the thread, the search, a read, a list, or a paired device holds the text of a summary.
- A choice sends only the owner's own message. It applies, dismisses, starts, stops, and changes nothing by itself, and the answer of a proposal, a grant task-writing turn, and a grant follow-up line carry none.
- A message never goes to a grant follow-up conversation, and the owner never chooses a conversation.
- A repository's thread never refuses a message for being full, and no read of the thread, its search, or its history for the prompt loads every conversation: each takes conversations newest first and stops when it is complete.
- An image is served only when a message of its conversation names it.
- Aril starts no session itself, except through the fixed grant actions while a grant the
  owner started is active: the desktop grant runner then starts an offered task or review,
  sends failed work back, or merges an offered pull request, behind every start gate.
  Otherwise only `apply` of a start proposal starts one, from the desktop window, through the
  manual start. The owner's **Start session** on the card approves the proposal; the shared
  native dialog confirms the start. One Apply is at most one launch.
- Aril never turns the queue on or off. Only `apply` of a queue proposal does, on the
  owner's answer, through `queue_settings` with the one setting `on`. The state is the
  one the proposal names, so no Apply reverses the queue.
- The chat starts no queued task. After the queue is on, only the desktop queue runner
  starts one, behind every start gate.
- The chat changes no queue to get a start through, sets no threshold or schedule, and
  never stops, attaches to, answers, approves, or steers anything in a session.
- A queue change that was refused or did not reach the monitor is never shown as made.
- A start that was held, failed, or cancelled is never shown as started, and is never
  retried without the owner's next Apply.
- A failed or stopped turn stores the text it had and its status. It never stores a
  proposal.
- A failed apply changes nothing further and reports each operation. Pomegr retries
  nothing by itself.
- Desktop main asks once for a follow-up per stored Apply or Dismiss. A complete
  follow-up may carry one board-change proposal continuing the owner's earlier request
  after any applied or partial outcome. Dismissed, refused, and failed outcomes yield no
  proposal; any block is rejected and marked `proposalUnreadable`. A follow-up applies
  no proposal, retries no operation, starts and steers no session, and changes no queue.
  The owner must Apply or Dismiss each follow-up proposal; each answer starts one
  provider run and no automatic chain.
- A follow-up that cannot run, or whose run fails, changes nothing of the proposal's
  stored outcome and never blocks the board.
- A dismissed proposal is never reported as a failure, and nothing of it is applied.
- When the monitor, the store, or the provider CLI is unavailable, the chat answers a
  fixed refusal. The board, the queue, and observation continue.
- Missing evidence is not success: a tool that answers unavailable is reported by Aril
  as unavailable, by instruction.

## Limits and unproven parts

1. **Provider versions.** The run needs the native flags listed above. An unsupported flag ends the turn as `failed`.
   Native reads were probed on Windows on 2026-10-17 with Claude Code 2.1.302 (`haiku`) and Codex 0.162.1 (`gpt-6-luna`).
   Both read synthetic source, discovered paths, searched text, read an authorized outside file, and retrieved full task text through `get_task`.
   Claude exposed only Read, Grep, Glob, and the eight Pomegr tools; its synthetic project hook did not run.
   Codex used MXC; an actual write command failed, and its guard file stayed unchanged.
   The elevated fallback was not exercised. Codex labels `prefer_mxc` under development.
   Every probe ended naturally, and its temporary files were deleted.
2. **Packaged MCP server.** The 2026-10-17 native-read probes ran the source MCP entry under Node.js.
   Earlier probes on 2026-10-11 ran the bundled server under development Electron with `ELECTRON_RUN_AS_NODE=1`.
   Native reads with the current configuration remain unproven from an installed build.
3. **Windows.** The executable lookup is the one a task start uses, which finds the
   Windows executables. On another platform `send` answers `cli_missing`.
4. **Feature context.** Aril cannot read a feature's description or app version, and a
   proposal cannot set them. An agent session does both through the feature tools.
5. **Cost.** Every message is a whole provider run with the board in its prompt. The
   chat shows no usage of its own; the Usage limits page shows the account's windows.
6. **Stale proposals.** Nothing marks a pending proposal that the board has moved past.
7. **Prompt injection.** Task text, issue text, and file content are data that an agent
   can still be misled by. The bounds are that the run cannot write, cannot reach another
   server, and cannot apply a proposal. The owner reads each proposal before it runs. A
   misled Aril can at most propose a start: the launch still needs the owner's **Start
   session** on the card in the desktop window, and the card names the task. It can
   likewise at most propose a queue change: the owner's **Turn queue on** still decides,
   and the card says what turning the queue on lets Pomegr start.
   The renderer of the desktop window can send a message and apply the proposal that
   answers it, so a start from the chat rests on the trusted window alone, where the
   task window's start also has the native confirmation.
8. **Start proposals from a live provider.** Probed on a device on 2026-10-12 with Claude
   Code 2.1.296 and Codex 0.162.1, on a synthetic board: for "start T-63" both wrote one
   valid `start_session` proposal. Claude Code also wrote none for a task with a session
   and none for a question about order. Codex was not asked those two. The probes started
   no session and are deleted. The Apply of a start and the launch are covered by tests
   with fakes. The product owner also applied a start proposal in the desktop app on
   2026-10-12 and the session launched; that build still showed the native confirmation.
   Which build that was is not recorded, so limit 2 stands.
9. **Separate worktree.** A start that only the repository's uncommitted changes hold
   answers `tree_dirty`. The chat offers no separate-worktree start; the task window
   does.
10. **Queue proposals from a live provider.** Not probed. The reading of a `set_queue`
    block, its Apply from the desktop window and through the paired-device gateway, the
    stored results, and the real task store behind the action are covered by tests with
    fakes. Whether Claude Code and Codex write the block for "turn the queue on", and
    write none without an explicit request, is not proven on a device.
11. **A paused queue.** The snapshot carries the queue's status and blocker but not its
    pause reason, so Aril can say that the queue is paused and that turning it on is the
    retry, and cannot say why the start failed. The Tasks page shows the reason.

12. **Images from a live provider.** Probed on a device on 2026-10-13 with Claude Code
    2.1.296 and Codex 0.162.1, on a synthetic board with one image of a single colour.
    Both providers named the colour, so both saw the image: Claude Code through
    `--add-dir` and Read, Codex through `--image` after the `-`. For "create a task
    about this image" and "attach this image to T-7", Codex wrote a valid proposal with
    the image's ID each time. Claude Code, on its smallest model, wrote a valid proposal
    in three of four runs; one run wrote a block that Pomegr could not read, and the
    cause was not recorded. The probes are deleted. The Apply of an image, the stored
    results, and the two paired-device image routes are covered by tests with fakes. An
    image sent from a paired phone, and an image attached through an installed build,
    are not proven on a device.
13. **Earlier images on Codex.** Codex gets only the images of the newest message
    attached. An earlier image is a listed file that Codex may open inside its sandbox;
    whether it does was not probed.
14. **No image without text.** A message that holds only an image is refused, and the
    panel does not offer it.
15. **Task images in the snapshot.** The snapshot does not say which images a task
    holds. Aril learns that a task is full only from the result of an applied proposal.

16. **Follow-ups from a live provider.** Not probed. That desktop main asks once, what
    the prompt holds for each outcome, what is stored, the waiting behind a running
    turn, and a provider that cannot answer are covered by tests with fakes. Whether
    Claude Code and Codex keep a follow-up short and limit any eligible proposal to the
    owner's earlier request remains unproven on a device.
17. **A follow-up costs a run.** Every Apply and every Dismiss starts one provider run
    with the board in its prompt, a dismissal included. The chat has no setting that
    turns follow-ups off.
18. **A waiting follow-up is not kept.** A follow-up that waits for another turn lives in
    memory. Closing the app before it starts loses it; the proposal's outcome stays.
19. **A session that links later.** A start that launched is followed up at once, before
    the session reports in, so the snapshot of that follow-up usually shows no session
    on the task yet. The request tells Aril that the launch is the only confirmed fact.
20. **Images across a rollover.** The prompt lists the image files of the conversation it answers in. An image the owner sent in an earlier conversation of the thread is named in its message line, but not listed as a file, and a proposal can name only an image of the conversation it is answered in.
21. **Compaction.** A thread longer than the 24,000 characters of the prompt's conversation section is summarized once its older messages total more than 8,000 characters. Up to 8,000 characters between the summary and the prompt's history can be left out of a prompt until then. The summary is Aril's own reading at effort `low`: it can miss a detail or put weight on the wrong one, and the prompt tells Aril to say that it no longer has what neither shows. A compaction reads at most the newest 6,000 messages without a summary, so older ones beyond that are never summarized. A repository's conversations are never deleted by size, so their files grow with use; the first read of a repository after the app starts reads each file once to build the index. Deleting a conversation does not rewrite the summary.
22. **Search is plain.** It matches a substring, whatever the case, in message text only: it does not rank, fold accents, or read a proposal's operations.
23. **Compaction costs a run.** Each summary spends the owner's provider allowance in a run that no message of the owner asked for, and a thread that keeps outgrowing its prompt asks again after each complete turn. A provider that fails leaves no summary and is asked again after the next complete turn.
24. **Compaction from a live provider.** Not probed. The tool-less arguments (`--tools ""` for Claude Code), the instructions' effect on a live model, and the summary a real run writes are covered by tests with fakes and not proven on a device. Codex has no switch that removes its shell: its compaction run keeps the read-only sandbox and is told to use no tool, and whether it obeys is not proven. Provider arguments change only with live evidence from one run of each provider, which this change did not collect.
25. **Where the time goes.** Timing records the milliseconds and the prompt lengths of each owner-message turn and compaction run, and the milliseconds of each step of an owner message's preparation, so the slow step can be read from real answers. The preparation's reads begin together, but the slowest still sets how long a message waits before its process starts: a GitHub read that times out takes 15 seconds, and the workflow read 5. The effect of beginning them together is not measured on a real machine yet. No effort is lowered for a short message until the numbers show it would help.
26. **Choices from a live provider.** Not probed. The block's reading and bounds, its storage, the prompt's rules and history lines, and the panel are covered by tests with fakes. Whether Claude Code and Codex write the block in this form, offer replies only when they must ask, and keep their answers short is not proven on a device. A model that writes an invalid block loses its choices silently, and the answer text stays.

## Change and verify

Route the change with the [agent workflow](../development/agent-workflow.md). A change
that adds an operation, a tool, a field of the snapshot, or a surface updates the
[Privacy](#privacy) section and the
[user guide](../../public/using-pomegr/agent-chat.md) together. A change to the provider
arguments needs live evidence from one run of each provider; delete the probe afterwards.
