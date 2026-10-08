# Task board and session dispatch

> Scope: the per-repository task board, the queue that starts sessions for its tasks,
> and the agent tools that add, complete, and block tasks. It does not cover
> observation, which stays read-only and is owned by the
> [observation cache](observation-cache.md).
> Authority: canonical design contract for tasks and dispatch, decided by the product
> owner on 2026-10-08. [AGENTS.md](../../../AGENTS.md) holds the privacy invariants and
> wins on conflict; an executable contract (`shared/task-contract.ts`, once it exists)
> wins on exact field shapes.
> Related code and checks: the owners and focused commands are routed in the
> [agent workflow](../development/agent-workflow.md); the delivery order is in the
> [task board plan](../plans/task-board.md).

**Status: designed, not built.** This page describes the contract that the plan
implements part by part. As of the charter part (2026-10-08) no task code exists: there is no task
store, route, board, queue, tool, or dispatch. Paths in code spans below are the
planned owners and may not exist yet. Each part that ships behavior updates this page
in the same change, so read a rule as binding for a capability only once the plan has
landed the part that builds it, and read the [status table](#what-is-built) for which
that is.

Pomegr becomes an observer plus an opt-in dispatcher. Observation is unchanged: it
reads provider data and never writes it. Tasks and dispatch are a separate control
plane that lets the user queue work for a repository and have Pomegr start a new
Claude Code or Codex session for it, in the desktop app only.

## What is built

| Capability | State |
| --- | --- |
| This contract and the privacy rules in AGENTS.md | Documentation only |
| Task store, board read, Tasks tab | Built: the store, `GET /api/tasks`, and the repository Tasks tab |
| Task creation | Built: in the desktop app, the Tasks tab's New task panel creates a task from its text. The task lands last in the first column, not queued |
| Run-on, effort, and done-when fields | Built: the New task panel and the task panel opened from a card set them, and the card shows them. The task panel also edits the task text and deletes the task. Nothing reads them yet: no session is started and no condition is verified |
| Move and columns | Built: in the desktop app a card is dragged to another column or onto a card to place it before that card, with move actions on the card as the keyboard alternative; columns are added, renamed, reordered, and deleted. Moving a card never changes its state |
| Features | Built (server): `feature_create`, and `create`/`update` attach a task to a feature at a step. The desktop UI is a separate change |
| Queue view and ordering | Built: the Tasks tab has a Board and a Queue view. The Queue view lists each feature's steps and the single queued tasks. In the desktop app a queued task is dragged to another step or to a new last step (keyboard alternative on the card), and the task panel adds a task to the queue and removes it. The monitor orders the queue and serves the order. No session is started yet |
| Agent tool `add_task` | Built: both plugins register the MCP tool `add_task`, which posts to `POST /api/agent/v1/tasks/add`. The task lands in the first column of the calling session's repository, not queued. Claude Code binds the call with a `PreToolUse` hook, Codex with `CODEX_THREAD_ID`; an unbound call is refused and posts nothing |
| Start a Claude Code session | Built: in the desktop app on Windows, the task panel's Start session action asks for a native confirmation and opens a Claude Code session for the task in a new terminal window. Start gates are not checked yet, and the started session is not linked to its task yet, so the card shows no session |
| Bind a started session to its task | Not built |
| Start a Codex session | Not built |
| `complete_task`, `block_task`, verified conditions | Not built |
| Stalled, queue advance, start gates | Not built |
| Parallel steps with worktrees, scheduling | Not built |
| Task on the Sessions list and in the session view | Not built |

Report-less completion (a task finishing from a deterministic condition with no agent
report) is deliberately not designed or implemented; see [Open questions](#open-questions).

## Ownership

The control plane has its own owners. Observation modules never import them, and
they never import observation internals beyond the shared value primitives.

| Owner | Responsibility | May not import |
| --- | --- | --- |
| `server/tasks/` | Task store, record validation, board projection, queue rules, done-when checks, start gates | `server/runtime/` or `server/serving/` (dependency-cruiser rule `only-entry-points-import-runtime-and-serving`); the `server-tasks-layer` rule limits it to `server/tasks/`, `server/normalize/`, and `server/persistence/` |
| `server/serving/task-routes.mjs` | HTTP for tasks, called from the request handler (pattern: `notification-routes.mjs`) | Task rules; it only parses, authorizes, and delegates |
| `shared/task-contract.ts` | Browser-visible types and bounds | Anything from `server/` or `desktop/` |
| `desktop/runtime/task-*.mjs` | Trusted IPC, session start, queue runner, worktrees | The renderer; `server/` internals (the monitor is reached over its internal HTTP) |
| `app/components/tasks/`, `app/tasks-store.ts`, `app/api/tasks/route.ts` | Presentation and the same-origin proxy | Credentials, raw session files, the store, any mutation path |
| `mcp/task-tools.mjs` and `plugin-src/` | Agent tools; never hand-edit `plugins/**` bundles, edit sources and run `npm run build:plugin` | `desktop/`; `server/` beyond the shared normalizers |

The pure rule modules take plain records and return plain values, with no store,
route, or Git access: `orderQueue(tasks, features)` in `task-queue.mjs`,
`verifyChecks(checks, facts)` in `task-checks.mjs`, and
`evaluateGates(task, facts, settings)` in `task-gates.mjs`. Composition code
gathers the committed facts they judge; they never acquire evidence.

## Store

Tasks live in a monitor-owned private store, separate from the observation cache and
from its retention and prune cycle, so pruning session history never deletes a task. It
reuses the `server/persistence/` primitives (prepared statements, the open and verify
pattern of `monitor-store.mjs`). The file is `tasks-v1/tasks.sqlite` under the monitor's
private data root, beside `monitor-store-v1` and outside its prune cycle.

- The store is versioned. A malformed or newer store is never overwritten by a routine
  write; the board then reports `unavailable`. Unlike the monitor store, a bad file is
  never rebuilt, and one stored row outside the contract makes the whole board
  `unavailable` instead of partly served.
- Bounds per repository: 500 tasks, 12 columns, and 50 features. Task text is at most
  4000 characters, an own condition 500, a column name 40, a feature name 80, and a
  block reason 200.
- `openTaskStore({ directory })` returns `readBoard(repositoryId)`,
  `apply(repositoryId, action, payload)`, and `close()`. `apply` returns the new board
  or a fixed error: `invalid`, `not_found`, `limit`, `conflict`, or `unsupported`. Later
  parts add actions, not methods.
- The first read of a repository seeds the default columns: Backlog, Ready, In
  progress, Review, and Done.

## Record

The designed browser-visible shape follows. `shared/task-contract.ts` owns the
executable version.

```ts
type TaskCheck = "pr_open" | "tree_clean" | "commit_on_branch" | "pr_merged" | "ci_passed";
type TaskState = "not_queued" | "queued" | "scheduled" | "needs_review" | "stalled" | "blocked" | "done";
type Task = {
  id: string;                 // "T-<n>", monotonic per repository
  text: string;
  columnId: string; position: number;
  featureId: string | null; step: number | null;      // step >= 1
  run: { provider: "claude" | "codex" | null; model: string | null; effort: "low" | "medium" | "high" | "xhigh" | null };
  doneWhen: { checks: TaskCheck[]; own: string | null };
  state: TaskState;
  scheduledAt: string | null;
  session: { id: string; title: string | null; state: string; observedModel: string | null } | null;
  report: { at: string; results: { check: TaskCheck; passed: boolean }[]; blockReason: string | null } | null;
  createdAt: string; updatedAt: string;
};
type TaskBoard = {
  version: 1; readiness: "ready" | "loading" | "unavailable" | "desktop_only";
  repositoryId: string;
  columns: { id: string; name: string; position: number }[];
  features: { id: string; name: string; done: boolean }[];
  tasks: Task[];
  queue: { status: "idle" | "running" | "blocked" | "paused"; blockedBy: string | null; order: string[] };
};
```

- A task is created with one free-text field, **Task**. There is no title field: a card
  shows the task text until its session has a title, then the session title. A new task
  always lands in the first column.
- `run` sets only the main agent of the started session, and every part of it is
  optional: a provider with a model or its "Default model", and an effort. `model` is
  validated like the request model identifier in [AGENTS.md](../../../AGENTS.md): at
  most 120 identifier characters, never a path, markup, or prose. A card shows the
  planned provider and model beside the observed model; the observed model is
  evidence, the planned one is intent. A model belongs to one provider, so a model
  without a provider is invalid; an effort alone is valid.
- `doneWhen.own` is a free-text condition that the agent judges. Pomegr does not
  evaluate it.
- `queue.order` holds task IDs only: the queued tasks in the order they would start (see
  [Queue](#queue)). It adds no task content, and the private queue position never leaves
  the monitor.
- A feature is `done` when every task attached to it is done. Only unfinished
  features are offered when attaching a task.
- `session` is a borrowed, normalized reference to the bound session (see
  [Session binding](#session-binding)); it carries no transcript content.

## States

A task has seven states and no liveness. While a session works on a task, the card
shows that session's observed state, borrowed from observation. There is no Running
task state.

| State | Meaning | Set by |
| --- | --- | --- |
| Not queued | On the board, not in the queue | Creation, removal from the queue, or a requeue before re-adding |
| Queued | In the queue, waiting for its turn and the start gates | The user adds it to the queue |
| Scheduled | Waiting for its own start time | The user sets a time |
| Needs review | The agent reported complete but a checked condition failed | Verification of a `complete_task` report |
| Stalled | The bound session ended without a report | Observation of an established session end |
| Blocked by agent | The agent called `block_task` with a reason | The agent |
| Done | The agent reported complete and every checked condition passed, or none was checked | Verification of a `complete_task` report |

**No transient states.** Never show a state and then retract it. The state is decided
at first observation of its evidence: Stalled is assigned only once the end of the
bound session is established by committed observation, never from an idle or paused
reading that a later observation could reverse. The same rule applies to every card
badge and chip derived from a task.

## Features and steps

A feature is an ordered list of steps. Tasks in the same step run in parallel, each in
its own Git worktree; a step starts only when every task of the step before it is
done. A task attached to a feature defaults to a new last step, and `step` is at least
1. Worktree creation and cleanup belong to the desktop (`task-worktree.mjs`); worktree
paths stay desktop-private and never reach the monitor store or browser state.

## Queue

The queue is the ordered set of queued tasks, ordered by the pure `orderQueue` rule. It
is advanced only by the desktop queue runner, only after the user turned the queue on,
and only one start at a time subject to the gates below. Until the part that starts
sessions lands, the queue only holds and orders tasks.

- **Order.** `queue.order` on the board lists the IDs of the tasks in state `queued`, in the
  order they would start, one ID per task. Features come in board order. Inside a
  feature the steps ascend, and the tasks of one step order by task number as a number
  (T-2 before T-10); they are the tasks that run in parallel. After every feature task
  come the single queued tasks, which have no feature or step. They run in the order
  they were queued, because no other order is defined for them. A task in another state
  is not in the order, even when it belongs to a queued task's feature. The first entry
  is the task shown as next.
- **Queue position.** Adding a task to the queue stamps it with a private integer, one
  above the highest the repository holds. The monitor keeps it beside the task and uses
  it only to order single tasks. It is never part of a task record or of the board.
  Removing a task from the queue clears it, so queuing it again places it last.
- **Steps.** `orderQueue` also reports every step of every feature with the IDs of its
  tasks of any state and whether the step is done (it has tasks and each one is done).
  The store uses that rule to refuse a move into a done step.

- **Stop on trouble.** Any failed check (Needs review), stalled task, or agent block
  sets the queue to `blocked` with the responsible task in `blockedBy`. Nothing new
  starts until the user resolves it, by **Mark done and resume** (`resolve_done`) or
  **Requeue** (`resolve_requeue`). Sessions already running continue.
- **No stop.** Pomegr never stops a running session, whether for a schedule, a
  gate, or a blocked queue.
- **Scheduling.** A task or the queue can start at a given time, and the queue can
  stop starting tasks after a given time. Scheduling runs only while the desktop app is
  open; what happens to a time that passed while it was closed is decided by the
  scheduling part and recorded here.

## Start gates

Before every start, `evaluateGates` judges committed facts and returns the reasons it
cannot proceed. A start needs all of the following.

1. The previous step of the task's feature is done.
2. The provider has usage capacity: the committed usage observation stays below a
   configurable threshold, 85% of the five-hour window by default. Unknown, stale,
   or partial usage is not capacity, so the gate holds (designed default, confirmed
   when the gates part lands).
3. The provider has no incident in the committed public provider status. Public
   status does not prove impact or causation, so it gates a start but is not shown as
   a cause.
4. The working tree of the repository root, or of the task's worktree, is clean.

The gates read already committed facts. They never acquire provider data, run Git
inspections on a request, or probe an account.

## Completion

The agent reports through the Pomegr MCP tool `complete_task`. Pomegr then verifies
the conditions the user checked and sets the state.

| Condition | Verified by Pomegr |
| --- | --- |
| Pull request open | Committed pull-request state of the task branch |
| Working tree clean | Committed repository state of the root or worktree |
| Commit on task branch | Committed Git facts of the task branch |
| Pull request merged | Committed pull-request state |
| CI passed | Committed pull-request check state (its source is added by the CI part) |
| Own condition | Not verified; the agent judges it in its report |

- Pass: Done. Fail: Needs review. The agent can call `block_task` with a bounded
  reason; the state becomes Blocked by agent. A session that ends without a report is
  Stalled.
- With no condition checked, the agent's `complete_task` report alone completes the
  task.
- The report keeps only `{ check, passed }` results, the time, and the bounded block
  reason. Command output, diffs, and provider payloads are never kept or exposed.
- Verification uses committed facts and never blocks on acquisition. A fact that is
  unknown is not a pass.

## Session binding

A tool call is bound to the calling session by the harness, never by a value the model
supplies.

- **Claude Code**: a `PreToolUse` hook, like `plugins/claude-code/scripts/rename-session.mjs`,
  supplies the session on every call.
- **Codex**: `CODEX_THREAD_ID`, as `resolveCurrentSessionRef` in `mcp/agent-query-tools.mjs`
  already does for the read tools.
- `add_task` targets the repository of the bound session. It never accepts a path or a
  repository ID.
- The monitor serves `add_task` as `POST /api/agent/v1/tasks/add`, beside the agent-query
  GETs and under the same gate: loopback host, no `Origin` header, and the agent token
  when one is configured. The body is a JSON object of at most 16 KiB with
  `Content-Type: application/json` and only these keys: `sessionRef` (`claude:<id>` or
  `codex:<id>`), `text`, and optionally `run`, `doneWhen`, and `feature` (a feature name).
  Any other key, including a repository ID or path, is `invalid`. The record rules are
  the store's. The monitor resolves `sessionRef` to the session's repository identity from
  committed facts, never reading Git or provider files, and creates the task as the
  desktop `create` action does: last in the first column, not queued. A `feature` must
  name an unfinished feature of that repository exactly; the task takes a new last step,
  and agents never create features.
- The answer is `{ schemaVersion: 1, ok: true, taskId }` or `{ schemaVersion: 1, ok: false,
  reason }`, never an echo of task content. Reasons: `invalid` (400), `session_not_found`
  (404), `repository_unavailable` (409), `feature_not_found` (404), `limit` (409), and
  `unavailable` (503). Any other path under `/api/agent/v1/tasks/` is not served, and no
  other agent route accepts a write.
- A started session carries an opaque random dispatch token in `POMEGR_TASK_TOKEN`. The
  plugin's session-start hook reports the token and the session ID to the monitor, which
  links the task to the session. `complete_task` and `block_task` act only on the task
  linked to the bound session.
- The token is a secret shared with the started process. It never reaches browser
  state, logs, reports, or notifications.

A session that was not started from a task has no linked task; its tools can still add
tasks to its repository.

## Starting a session

Starting is desktop-only and explicit.

1. A manual start shows a native confirmation. The queue runner starts without a prompt
   only after the user turned the queue on.
2. The runner opens a visible terminal window in the repository root, or in the task's
   worktree, that runs the provider CLI. It uses `spawn` with an argument array and
   `shell: false`. Task text is untrusted user content and is never interpolated into
   a command line or a path.
3. The session prompt is a fixed template holding the task text, the done-when list, and
   the instruction to call `complete_task` or `block_task`.
4. The start is refused with a fixed reason when the Pomegr plugin is not installed in
   the repository, a gate fails, or the platform is not Windows (fixed result
   `unsupported_platform`).

Built so far: the manual start of a Claude Code session, with no start gate.

- The renderer calls the fixed IPC channel `pomegr:task-start` with a repository ID and a
  task ID. It gets back one fixed status and nothing else: `started`, `cancelled`,
  `unsupported_platform`, `cli_missing`, `plugin_missing`, `not_startable`,
  `unsupported_provider`, `not_found`, `busy`, `invalid`, `unavailable`, or `failed`.
- Desktop main checks the platform and finds the Claude Code executable, then shows the
  native confirmation, which names only the task ID. Only after the user confirms does it
  ask the monitor for the start plan, because the plan mints a single-use token.
- `POST /internal/tasks/start-plan` answers the plan for a startable task: provider,
  model, effort, the repository root resolved monitor-side, the prompt, and the dispatch
  token. A task is startable when its state is `not_queued`, `queued`, or `scheduled`, no
  session is linked, and no dispatch is live. A task with no provider starts Claude Code;
  a Codex task answers `unsupported_provider`. The monitor refuses with `plugin_missing`
  unless the committed plugin setup of the repository shows the Claude Code plugin
  installed, ready, and enabled, and with `unavailable` when it has not identified the
  repository's root in the current run.
- The monitor stores only the SHA-256 digest of the token and its mint time. An unbound
  dispatch is live for ten minutes; after that the task can be started again.
- Desktop main validates the plan, then opens the terminal through one fixed PowerShell
  command (`Start-Process`), run with `spawn`, an argument array, and `shell: false`. A
  detached child of a windowless app gets no console, so the executable cannot be
  spawned directly. The command line is constant: the executable, its argument string,
  and the directory travel only as environment variables, which PowerShell reads as
  values and never parses as script, and which are removed before the session starts.
  The argument string holds `--model` and `--effort` only when set, followed by the
  prompt as one argument, each quoted by the Windows command-line rules. The environment
  is the native Claude allowlist of the active provider profile plus
  `POMEGR_TASK_TOKEN`. Pomegr keeps no handle to the session.
- When the plan is malformed or the launcher fails or does not end within 15 seconds,
  desktop main calls
  `POST /internal/tasks/start-abort` with the token, which clears the matching dispatch.
- Starting never changes the task's state, column, or queue position.

Claude Code and Codex are both startable. Pomegr never attaches to, writes input to,
approves for, or stops the started process; afterwards it only observes the session
like any other.

## Boundaries

| Surface | Who | What it carries |
| --- | --- | --- |
| `GET /api/tasks?repositoryId=repo-<24 hex>` | A same-computer client, gated like `GET /api/provider-folders`; not on the LAN gateway list | The committed board, `no-store`. A denied client gets `readiness: "desktop_only"` and no task content |
| `pomegr:task-action` IPC | The renderer, through a trusted main frame only | A fixed action name, the repository ID pattern, and a payload of at most 16 KiB |
| `POST /internal/tasks/<action>` | Desktop main, with the desktop token | The same action; the monitor validates the whole record |
| `pomegr:task-start` IPC | The renderer, through a trusted main frame only, behind a native confirmation | A repository ID and a task ID; answers one fixed status |
| `POST /internal/tasks/start-plan` and `start-abort` | Desktop main, with the desktop token; not reachable through `pomegr:task-action` | The start plan with the repository root, prompt, and dispatch token; none of them reaches the renderer or `GET /api/tasks` |
| `POST /api/agent/v1/tasks/add\|complete\|block` | An agent through the MCP tools, authorized like the agent-query GETs | The only agent writes; no other path may be added without updating the AGENTS.md rule |

- The fixed IPC actions are `create`, `update`, `delete`, `move`, `column_create`,
  `column_rename`, `column_reorder`, `column_delete`, `feature_create`, `queue_add`,
  `queue_remove`, `queue_reorder`, `queue_settings`, `resolve_done`, and
  `resolve_requeue`. An action whose part has not landed answers a fixed `unsupported`
  result. Built so far: `create` with `{ text, run?, doneWhen? }`, `update` with
  `{ id, text?, run?, doneWhen? }`, and `delete` with `{ id }`; a payload with any other
  key is `invalid`. In `update` at least one of the three fields is required, a field
  that is present replaces the stored one whole (a null `run` or `doneWhen` clears it),
  and an absent field is left as stored. `move` takes `{ id, columnId, position }`:
  `position` is the zero-based index in the destination column counted after the task
  leaves its place, and a value past the end appends. `column_create` takes `{ name }`
  and appends the column, `column_rename` takes `{ id, name }`, `column_reorder` takes
  `{ id, position }` with the same clamping, and `column_delete` takes `{ id }`. A
  thirteenth column answers `limit`. Deleting a column that holds tasks, or the last
  column, answers `conflict`. Task and column positions stay dense after every action.
  `feature_create` takes exactly `{ name }` (one line, 1 to 80 characters); a
  duplicate name in the repository answers `conflict` and a 51st feature `limit`. A
  feature with no task is listed with `done: false`. `create` and `update` take two
  optional keys, `featureId` (a feature ID or null) and `step` (an integer of at least 1
  or null). Joining a feature without a step lands in a new last step; a `step` is valid
  from 1 to the feature's highest step + 1 (measured before a move), otherwise `invalid`,
  and a step without a feature is `invalid`. An unknown feature, or one of another
  repository, is `not_found`; a done feature (it has tasks and all are done) refuses a
  task that is not already in it with `conflict`. In `update`, `featureId: null`
  detaches (a step sent with it must be null), and the task's own feature ID or a `step`
  alone moves it inside its feature. Steps stay dense (1 to n) after every write that
  changes a task's feature or step, or deletes a task in a feature, renumbering without
  changing the update time of other tasks. There is no feature rename, delete, or
  reorder yet.
  `queue_add` takes exactly `{ id }`: a task in state `not_queued` becomes `queued`; any
  other state is `conflict`, and an unknown task is `not_found`. `queue_remove` takes
  exactly `{ id }`: a `queued` task becomes `not_queued`; any other state is `conflict`.
  `queue_reorder` takes exactly `{ id, step }` with `step` an integer of at least 1. The task
  must exist (`not_found`) and be queued and in a feature (otherwise `conflict`; a single
  task is not reordered). `step` is valid from 1 to the feature's highest step + 1, measured
  before the move, where the highest + 1 is a new last step; anything else is `invalid`. A
  target step whose tasks are all done answers `conflict`. Moving a task to its own step, or
  the only task of the last step to a new last step, succeeds and changes nothing. Otherwise
  the steps are renumbered densely in the same transaction (a step the move empties
  disappears) without changing the update time of other tasks, and the task stays
  `queued`. The three actions start no session and leave the stored queue status as it is.
  There is no insertion of a step between two others yet. `queue_settings`, `resolve_done`,
  and `resolve_requeue` still answer `unsupported`.
- The list is written three times, because the layers may not import each other:
  `server/tasks/task-record.mjs`, `server/serving/task-routes.mjs` (pinned to the first
  by `tests/server/tasks/task-actions.test.mjs`), and `desktop/runtime/task-action.mjs`
  with its copy in `preload.cjs`. A part that adds an action changes all of them.
- The POST body is `{ "repositoryId": "repo-<24 hex>", "payload": { ... } }`. The
  monitor answers `no-store` JSON, `{ "ok": true, "board": ... }` or
  `{ "ok": false, "error": ... }`: 200 on success; 400 `invalid`; 404 for an unknown
  action name (`invalid`) or an unknown task (`not_found`); 409 `limit` or `conflict`;
  413 `invalid` for an oversize body; 501 `unsupported`; 503 `conflict` when the store
  is missing, malformed, or newer. A request without the desktop token, from a
  non-loopback host, or with an `Origin` header gets the private-action gate's 401 and
  writes nothing.
- `desktop/runtime/task-action.mjs` owns the IPC handler. It returns to the renderer
  only `{ ok: true }` or `{ ok: false, error }`, where `error` is one of the store's
  five values or `unavailable` (the monitor could not be reached or answered
  something else). The board never crosses the IPC: the renderer reads it again
  through `GET /api/tasks`. A refused call answers `invalid` and posts nothing.
- A task ID comes from a per-repository counter, so a number is never reused after a
  delete.
- The `GET` is a committed-store read. It acquires no provider evidence and never
  triggers observation.
- Browser and LAN clients never mutate tasks or start sessions.
- The seven MCP observation tools stay read-only, as in [MCP observation queries](mcp-queries.md).
  The task tools are a separate registration with the three write paths above.

## Privacy

Task text, the own condition, and column and feature names are user-authored content, a
new data class.

- They live only in the task store, and are served only by `GET /api/tasks` and the
  desktop IPC.
- They never enter `/api/state`, session catalogs, reports, logs, notifications,
  diagnostics, pipeline-operations logs, or observation checkpoints, and no pipeline
  stage reads them.
- The Sessions list and session view receive only the task ID, task state, feature name,
  and step. That is a deliberate, later widening of exposure: the part that builds it
  updates the AGENTS.md rule in the same pull request, and it must not carry task text,
  the own condition, or a column name.
- Task state shown beside a session is a projection of the task store, never an
  observation of the session.
- Provider and model names, effort, check results, and times are normalized enums or
  identifiers, not user content.

## Invariants and failure behavior

- Observation is unchanged and independent. If the task store, a route, or the dispatcher
  fails, observation, serving, and notifications continue, and the Tasks tab reports
  `unavailable`. If observation is unavailable, the board still reads, but borrowed
  session state is unknown rather than guessed.
- A mutation that fails validation changes nothing and returns a fixed error.
- Preserve the last known-good board. A write replaces it atomically or not at all.
- Task and queue behavior is deterministic. Pomegr verifies conditions from committed
  facts; it makes no AI judgment about whether work is complete, and the own condition
  is judged by the agent and labeled as such.
- Missing evidence is not success. A session that vanished is Stalled only after its
  end is established; unknown is shown as unknown.

## Open questions

1. **Report-less completion.** May a deterministic condition, for example the pull
   request being merged, complete a task when the agent never reported? The product
   owner has not decided. Do not implement it; a session without a report is Stalled.
2. **Browser read.** Should the same-computer browser read `GET /api/tasks`, as
   designed, or should the board be desktop only? Until answered, the read follows the
   `GET /api/provider-folders` gate and exposes nothing to the LAN.

## Change and verify

Route the change with the [agent workflow](../development/agent-workflow.md), then run
the focused commands of the owning row. A change that adds a field, route, tool, or
surface to the task data class updates the AGENTS.md rule and this page together, and
the first part that adds `server/tasks/` also adds its layer rule to
`.dependency-cruiser.cjs` and its row to the server layout table. Run
`npm run check:boundaries` for import direction and `npm run check:docs` for this
page.
