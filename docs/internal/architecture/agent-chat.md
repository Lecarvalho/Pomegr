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
> T-75). A change that widens exposure changes the
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
answers. Aril never changes anything. It proposes board changes, and Pomegr applies a
proposal only after the owner presses **Apply changes**. When the owner asks for it, Aril
also proposes to start a session for one named task; Pomegr starts it through the manual
start of the Tasks page, only after the owner selects **Start session** on that proposal
in the desktop app
(see [Session start](#session-start)). When the owner asks for it, Aril also proposes to
turn the repository's queue on or off; Pomegr sends the Tasks page's own queue action,
only after the owner selects **Turn queue on** or **Turn queue off** on that proposal, in
the desktop app or on a paired device (see [Queue change](#queue-change)). The user guide is
[Agent chat](../../public/using-pomegr/agent-chat.md).

## Ownership

Desktop main owns the whole chat. The monitor does not know that the chat exists: it
serves the board and takes the fixed task actions as it does for the Tasks page.

| Owner | Responsibility | May not |
| --- | --- | --- |
| `desktop/runtime/agent-chat.mjs` | The operations, the one running turn, the trusted IPC handler, the answers, the hand-off of an approved session start to the manual start, and the one request of an approved queue change | Pass provider, monitor, or error text through; import `server/`; start a session by any path but the manual start it is given, or for a call that is not the desktop window's; send `queue_settings` with any setting but `on` |
| `desktop/runtime/agent-chat-runner.mjs` | The fixed provider arguments, the process, and the reading of its output | Put the prompt or any owner text in an argument, a path, or the environment |
| `desktop/runtime/agent-chat-prompt.mjs` | The instructions, the board snapshot, and the conversation history of one turn | Read anything itself |
| `desktop/runtime/agent-chat-proposal.mjs` | Reading, validating, and applying a proposal | Reach the board except through the caller's task-action request; start a session; change the queue |
| `desktop/runtime/agent-chat-store.mjs` | The saved conversations | Write outside its directory, or overwrite a file outside the contract |
| `mcp/agent-chat-server.mjs` | The chat's own MCP server with the seven read tools | Register a signal, task, or feature tool |
| `desktop/runtime/lan-gateway.mjs` | The one chat route of a paired device | Forward a chat request to the web host |
| `shared/agent-chat-contract.ts` | Browser-visible types and bounds | Import `server/` or `desktop/` |
| `app/agent-chat-client.ts`, `app/components/agent-chat/` | The transport, the chat state, and the panel | Keep conversation content in browser storage, or change the board except through the chat's `apply` |

## One turn

Each message of the owner starts one provider run. The run answers and exits.

1. The client sends `send` with the repository, the conversation or none, the message,
   the provider, and the model or none.
2. Desktop main refuses the message when a turn is already running anywhere (`busy`).
   One turn runs at a time for the whole app.
3. It finds the provider's executable with the same rules a task start uses. No
   executable answers `cli_missing`.
4. It reads the board (`GET /api/tasks` on the monitor, with the desktop token) and the
   repository root (`POST /internal/tasks/worktree-root`). A board that is not ready, or
   a repository the monitor has not located in this run, answers `unavailable`.
5. It builds the prompt (see [Prompt](#prompt)), stores the owner's message, and starts
   the run in the repository root. The answer to `send` is the conversation ID only.
6. While the run writes, `read` answers the stored conversation and a `turn`: the
   answer text so far and one fixed activity label.
7. When the run ends, desktop main stores Aril's message with one status: `complete`,
   `stopped`, `failed`, or `timed_out`. A run may take ten minutes.

The run is a new provider conversation every time. Pomegr sends the earlier messages in
the prompt, so the owner may change the provider or the model between two messages.

### The provider run

The run is the owner's own provider CLI, signed in as the owner. Pomegr reads and stores
no credential, and offers no sign-in of its own. The arguments are fixed
(`chatArguments` in `agent-chat-runner.mjs`); only a validated model identifier and the
desktop's own MCP server vary.

- **Claude Code:** print mode with JSON lines, `--no-session-persistence`,
  `--restricted`, `--strict-mcp-config` with one `--mcp-config`, `--permission-mode
  dontAsk`, `--tools Read,Grep,Glob`, and an allow list of those three tools and the
  seven Pomegr read tools.
- **Codex:** `exec --json --ephemeral --sandbox read-only --skip-git-repo-check
  --ignore-user-config --ignore-rules --disable apps`, the MCP server as three `-c`
  values, and `-` for the prompt on stdin.

What this gives the run, on every computer:

- It reads the repository's files. Claude Code has Read, Grep, and Glob. Codex has its
  shell inside the read-only sandbox.
- It has the seven Pomegr read tools (see [Tools](#tools)).
- It has no tool that writes a file, runs a command that changes something, or reaches
  another MCP server. The owner's settings, hooks, plugins, and other MCP servers are not
  loaded.
- It cannot wait for an approval. A tool outside the allow list is refused.
- It leaves no session file, so Pomegr does not observe it and nothing can resume it.

The process starts with `spawn`, an argument array, and `shell: false`. The prompt
travels on stdin. Nothing the owner typed and nothing from the board is in an argument,
a path, or the environment. The environment is the owner's own, as for a task start
(`userSessionEnvironment`): the app's own variables and tokens are left out.

**Stop** ends this run. It is Pomegr's own headless process and never a session the
owner started. Closing the app ends a running turn the same way.

### Tools

The chat's MCP server is `mcp/agent-chat-server.mjs`, bundled as
`desktop/workers/agent-chat-mcp.cjs` and started by the provider run over stdio. The
command is the desktop executable with `ELECTRON_RUN_AS_NODE=1`, so it needs no Node on
the computer and no Pomegr plugin in the repository.

It registers the seven observation tools of
[MCP observation queries](mcp-queries.md) and nothing else: `list_sessions`,
`get_session_report`, `list_session_agents`, `get_agent_context`,
`get_recent_failures`, `get_usage_limits`, and `get_provider_health`. They use the same
loopback routes, the same local descriptor, and the same answers as the plugin's tools.
No host session is bound, so a session tool needs an explicit session reference. The
board snapshot gives the reference of each task's session.

When the bundle is missing, the run starts without an MCP server and Aril works from the
board snapshot and the files.

### Prompt

`composePrompt` in `agent-chat-prompt.mjs` builds one text of at most 200,000
characters, in this order:

1. **Instructions.** A fixed text (`AGENT_CHAT_INSTRUCTIONS`): who Aril is, what it may
   read, that it only proposes, how to advise on task size, steps, order, and models,
   the proposal format, when it proposes a session start or a queue change, and that
   all following content is data.
2. **Board snapshot.** One JSON line (`boardSnapshot`): the repository folder name, the
   time, the column names, the features (title and whether done), the queue (status,
   order, blocker, start threshold, and the usage percentages of the start gates), the
   models seen on the board and the Codex model list, and every task.
3. **Conversation.** The newest earlier messages that fit 24,000 characters, oldest
   first. A proposal is one line with its summary, its outcome, and the IDs it created.
   A session start is one line with the task ID and what happened to it: not answered,
   dismissed, launched, or not started with the fixed start status. A queue change is
   one line with the state it asked for and what happened: not answered, dismissed,
   on, on and held, off, or not changed with the fixed error.
4. **The owner's message.**

A task in the snapshot holds its ID, column, state, feature title, step, planned
provider, model and effort, complete-when checks and own condition, the linked session's
reference, state and observed model, the report's results (each one passed, failed, or
unavailable), block reason and attention
line, the GitHub issue number, the scheduled time, the update time, and the task text.
Task text shares a budget of 48,000 characters. Unfinished tasks get their whole text
first; past the budget a task carries 240 characters and `text_cut`.

The snapshot holds no path, token, repository ID, column ID, feature ID, image, or
dispatch fact. A feature's description and app version are not in it.

Aril's advice on models is a reading of this recorded evidence. It is never presented as
a measurement or a benchmark.

## Proposals

Aril changes the board only by ending its answer with one fenced block tagged
`pomegr-board`: `{ "summary", "operations" }`. `extractProposal` in
`agent-chat-proposal.mjs` takes the block out of the shown text and validates it.

- A proposal holds 1 to 40 operations and a one-line summary of at most 300 characters.
- An answer with two blocks, an unclosed block, malformed JSON, or one operation outside
  the contract carries no proposal. The message is marked `proposalUnreadable`, and the
  panel says so. Nothing is offered and nothing is guessed.
- Only a `complete` answer can carry a proposal.
- While the answer is written, a block that has begun is not shown.

| Operation | Fields | Task action when approved |
| --- | --- | --- |
| `create_feature` | `name` | `feature_create`; a feature of that title that is already open is the outcome asked for, so nothing is sent |
| `create_task` | `text`; optional `feature`, `step`, `provider`, `model`, `effort`, `complete_when`, `own_condition`, `queue` | `create`, then `queue_add` when `queue` is true |
| `update_task` | `id`; any of `text`, `feature` (null takes the task out of its feature), `provider`, `model`, `effort`, `complete_when`, `own_condition` | `update` |
| `delete_task` | `id` | `delete` |
| `move_task` | `id`, `column`; optional `position` | `move`; without a position the card goes last |
| `queue_task` | `id` | `queue_add` |
| `unqueue_task` | `id` | `queue_remove` |
| `set_step` | `id`, `step` | `queue_reorder` |
| `start_session` | `id` | None. It is not a board change: see [Session start](#session-start) |
| `set_queue` | `on`, a boolean | `queue_settings` with `{ on }`, sent on its own path: see [Queue change](#queue-change) |

- A feature is named by its exact title. Desktop main resolves it against the board when
  the proposal runs, so a `create_task` may name a feature that an earlier
  `create_feature` of the same proposal makes.
- An update sets only the parts it names. The applier fills the rest of `run` and
  `completeWhen` from the stored task, and keeps the task's Remote Control and
  keep-worktree flags.
- The monitor validates every action as it does for the desktop app. The rules of
  [Tasks](tasks.md) hold: a started task is read-only, a waiting card stays in Ready,
  and a bound applies.

No operation marks a task done, requeues a task, changes a feature's title or
description, deletes a feature, attaches an image, sets the queue's threshold or
schedule, or touches GitHub. Only `start_session` starts a session, and only `set_queue`
turns the queue on or off, each by the rules below.

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
  `pomegr:task-start` without the native confirmation: the trusted-frame check, the start
  plan with every gate ([Tasks: Starting a session](tasks.md#starting-a-session)), and
  the one launch slot that manual and queued starts share. The chat adds no path of its
  own.
- **The card is the confirmation.** Product-owner decision of 2026-10-12, after trying
  the first build: **Start session** on the proposal card, which names the task, is the
  explicit confirmation of this start, and no native dialog follows it. It replaces the
  rule of the same day that the native confirmation also showed. The start of the task
  window keeps its native confirmation.
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
  start the queued tasks, one step at a time, with no further confirmation. The chat
  starts none of them: only the runner does, on its next poll, through the dispatcher
  the Tasks page uses. Every gate holds as it does there: the queue order and steps, a
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

### Approval

A stored proposal is `pending`. The owner answers it once.

- **Apply changes** (`apply`) of a proposal of board changes reads the board, then runs
  the operations in order, one task action each (`applyOperations`). It stops at the first operation that fails. The
  operations after it answer `skipped`. The proposal becomes `applied` when every
  operation succeeded, else `partial`, with one result per operation: success, the new
  task's ID, or one fixed error.
- **Start session** is the `apply` of a start proposal. It reads no board and sends no
  task action (see [Session start](#session-start)).
- **Turn queue on** and **Turn queue off** are the `apply` of a queue proposal. It reads
  no board and sends the one queue action (see [Queue change](#queue-change)).
- **Dismiss** (`dismiss`) stores `dismissed` and sends nothing.
- A proposal that is not `pending` answers `conflict`. Two answers at once: the second
  answers `busy`.
- What runs is the stored proposal, the one the panel showed. The client sends only the
  proposal's ID.
- A proposal can be stale when the board changed after Aril wrote it. Nothing is
  checked ahead: each action answers for itself, and a task that is gone is `not_found`.
- Nothing is undone. A deleted task stays deleted, as on the Tasks page.

## Conversations

Desktop main keeps one JSON file per conversation:
`<desktop data root>/agent-chat-v1/<repository ID>/<conversation ID>.json`, holding
`{ version: 1, repositoryId, conversation }`.

- A conversation has an ID (`chat-<12 hex>`), a title (the first line of the first
  message, at most 80 characters), the provider and model last used, two times, and its
  messages.
- Bounds: 50 conversations for each repository, 200 messages for each conversation, 4,000
  characters for a message of the owner, and 32,000 for an answer. A full repository or
  conversation answers `limit`.
- A write replaces the file whole, through a temporary file and a rename.
- A file outside the contract, of another version, or over the size bound is never
  listed and never overwritten.
- Nothing deletes a conversation except the owner's **Delete** (`delete`). Storage
  retention and the prune cycle of the observation store do not touch this directory.
- A conversation that ends on the owner's message with no run behind it lost its answer:
  the app closed during the turn. The next read adds one answer with the status
  `interrupted`.

## Boundaries

| Surface | Who | What it carries |
| --- | --- | --- |
| `pomegr:agent-chat` IPC | The renderer, through a trusted main frame only | One fixed operation and a payload of at most 17 KiB; answers the chat's own bounded answer. The only surface whose `apply` can start a session |
| `POST /api/agent-chat` on the LAN gateway | A paired device only | `{ operation, payload }` with the same operations and bound; the gateway answers it in desktop main and never forwards it. Its `apply` of a session start answers `desktop_only`. Its `apply` of a queue change is accepted |
| The manual start in desktop main (`createTaskStart().startApproved`) | Desktop main, for an approved start proposal of the desktop window | The window event, the repository ID, and the task ID in; one fixed start status out. No prompt, plan, path, or token reaches the chat |
| `GET /api/tasks` and `POST /internal/tasks/worktree-root` on the monitor | Desktop main, with the desktop token | The board for the prompt and for an apply; the repository root for the run's working directory |
| `POST /internal/tasks/<action>` on the monitor | Desktop main, with the desktop token | One of `create`, `update`, `delete`, `move`, `feature_create`, `queue_add`, `queue_remove`, and `queue_reorder`, for an approved proposal of board changes; `queue_settings` with exactly `{ on }`, for an approved queue proposal |
| The provider run | Desktop main | The prompt on stdin; JSON lines on stdout |

The operations and their payloads, each with `repositoryId`:

| Operation | Other keys | Answer on success |
| --- | --- | --- |
| `list` | none | The conversations (ID, title, update time, message count) and the conversation being answered, or null |
| `read` | `conversationId` | The conversation and the running `turn` or null |
| `send` | `conversationId` or null, `text`, `provider`, `model` or null | The conversation ID |
| `stop` | `conversationId` | Nothing more |
| `apply`, `dismiss` | `conversationId`, `proposalId` | Nothing more; the client reads the conversation again. An `apply` of a session start also answers success when the start was held, failed, or cancelled: the stored proposal says which. An `apply` of a queue change also answers success when the monitor refused it or did not answer |
| `delete` | `conversationId` | Nothing more |

A refusal is `{ ok: false, error }` with one of `invalid`, `not_found`, `busy`, `limit`,
`cli_missing`, `conflict`, `unavailable`, and `desktop_only`. A payload with another key
is `invalid`. `desktop_only` answers only the `apply` of a session start that did not
come from the desktop window.

- The paired-device route takes the POST only with the session cookie, the gateway's own
  `Origin`, a JSON content type, no query, and a declared body of at most 17 KiB, like
  the task-action route. A same-computer browser and the development server have no chat
  route, so the panel is not drawn there.
- The preload exposes `agentChat(operation, payload)`. It refuses an unknown operation
  or a payload without a repository ID before any call.
- A `turn` carries the conversation ID, the start time, the provider, the model, the
  answer text so far, and one activity: `starting`, `thinking`, `reading_files`,
  `reading_sessions`, `reading_usage`, or `writing`. The label is chosen from the tool's
  name. No tool input, tool result, or provider error text is read into an answer.

## Privacy

The conversation is a new data class: text the owner wrote and text the agent wrote. It
is the one place where Pomegr shows a prompt and a response, and they are the chat's own,
never a session's.

- **Where it lives.** In the conversation files under the desktop data root, and in
  desktop main's memory. Not in the monitor, the task store, the observation store, a
  checkpoint, a report, a log, a notification, or diagnostics.
- **Who gets it.** The trusted renderer through `pomegr:agent-chat`, and a paired device
  through `POST /api/agent-chat`. No GET serves it. A same-computer browser gets nothing.
  The renderer keeps it in memory only; browser storage holds only the ID of the
  repository chosen last.
- **What reaches the provider.** Each turn sends the prompt to the provider the owner
  chose, through the owner's CLI. That prompt holds the owner's messages, Aril's earlier
  answers, and the board snapshot: task text, own conditions, feature titles, block
  reasons, attention lines, session references, and model names. This is a deliberate
  widening: before the chat, a task's text reached a provider only in the prompt of its
  own session. The run can also read the repository's files and call the seven read
  tools, so file content and normalized session evidence can reach the provider in the
  same run, as they can in any session the owner starts in that folder.
- **What never enters a prompt.** Credentials, tokens, the desktop token, a repository
  ID, a path other than the working directory the process starts in, task images, and
  the description or app version of a feature.
- **What Pomegr keeps of the run.** The final answer text and the status. Tool calls,
  tool results, reasoning, usage, cost, and provider errors are read past and dropped.
  The provider's stderr is not read.
- **What Pomegr keeps of a session start.** The task ID of the proposal and one fixed
  start status, in the conversation file. Nothing of the start plan reaches the chat: no
  prompt, repository root, worktree path, image file, dispatch token, or launcher output.
  A paired device that reads the conversation sees that status like the rest of it.
- **What Pomegr keeps of a queue change.** The state the proposal asked for and one
  fixed result, in the conversation file: `on`, `blocked`, `off`, or a fixed error. No
  task ID, blocker, pause reason, gate reading, or board content is kept with it, and
  the action sends the monitor only `{ on }`.
- **Paired devices.** The gateway serves plain HTTP on the local network, so the
  conversation and the session cookie cross it unencrypted, as task content does.
  Whoever holds a paired device's cookie can read the conversations, send a message
  (which spends the owner's provider allowance in a read-only run), and apply a
  proposal of board changes or a queue change. It cannot apply a session start from
  the chat. Applying a queue change that turns the queue on lets the desktop start the
  queued tasks, which the same holder can already do through `POST /api/tasks/action`
  ([Tasks: Paired devices](tasks.md#paired-devices)). The card's Primary is an
  owner-facing boundary, not proof against a holder of the cookie. Revoking
  phone access ends this at once. The product owner asked for the
  chat on a paired device on 2026-10-11, and for the queue change there on 2026-10-12
  (task T-75), and accepts this as part of phone access.
- **Fixed answers.** A refusal is one fixed word. No answer carries a path, a command,
  a token, or error text.

## Invariants and failure behavior

- Observation is unchanged. No chat run is observed, and no pipeline stage reads a
  conversation.
- Aril never changes the board. Only `apply` does, on the owner's answer, through the
  fixed task actions.
- Aril never starts a session. Only `apply` of a start proposal does, from the desktop
  window, through the manual start and behind every start gate. The owner's **Start
  session** on the card is its confirmation. One Apply is at most one launch.
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
- When the monitor, the store, or the provider CLI is unavailable, the chat answers a
  fixed refusal. The board, the queue, and observation continue.
- Missing evidence is not success: a tool that answers unavailable is reported by Aril
  as unavailable, by instruction.

## Limits and unproven parts

1. **Provider versions.** The Claude Code run needs a version with `--restricted`
   (2.1.248 or later). An older CLI ends the turn as `failed`. Probed on a device on
   2026-10-11 with Claude Code 2.1.296 and Codex 0.162.1: both providers answered, called
   a read tool of the bundled MCP server, and wrote a valid proposal. The probes are
   deleted.
2. **Packaged MCP server.** In those probes the bundled server ran under the
   development Electron binary with `ELECTRON_RUN_AS_NODE=1`. The same start from an
   installed build, out of the unpacked application folder, is not proven on a device.
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

## Change and verify

Route the change with the [agent workflow](../development/agent-workflow.md). A change
that adds an operation, a tool, a field of the snapshot, or a surface updates the
[Privacy](#privacy) section and the
[user guide](../../public/using-pomegr/agent-chat.md) together. A change to the provider
arguments needs live evidence from one run of each provider; delete the probe afterwards.
