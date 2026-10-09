# Task board and session dispatch

> Scope: the per-repository task board, the queue that starts sessions for its tasks,
> and the agent tools that add, complete, and block tasks. It does not cover
> observation, which stays read-only and is owned by the
> [observation cache](observation-cache.md).
> Authority: canonical design contract for tasks and dispatch, decided by the product
> owner on 2026-10-08. [AGENTS.md](../../../AGENTS.md) holds the privacy invariants and
> wins on conflict; the executable contract `shared/task-contract.ts` wins on exact
> field shapes.
> Related code and checks: the owners and focused commands are routed in the
> [agent workflow](../development/agent-workflow.md).

**Status: built.** Every capability on this page has shipped: the board, features and
steps, the queue with its start gates and schedule, session start for Claude Code and
Codex on Windows, session binding, the three agent tools, verified conditions, and the
task reference on the Sessions list and in the session view. The user guide is
[Tasks](../../public/using-pomegr/tasks.md). Report-less completion (a task finishing
from a deterministic condition with no agent report) is deliberately not designed or
implemented; see [Open questions and unassigned work](#open-questions-and-unassigned-work).

Pomegr is an observer plus an opt-in dispatcher. Observation is unchanged: it
reads provider data and never writes it. Tasks and dispatch are a separate control
plane that lets the user queue work for a repository and have Pomegr start a new
Claude Code or Codex session for it, in the desktop app only.

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
  or a fixed error: `invalid`, `not_found`, `limit`, `conflict`, or `unsupported`. A new
  capability adds an action, not a method.
- The first read of a repository seeds the default columns: Backlog, Ready, In
  progress, Review, and Done.

## Record

The browser-visible shape follows. `shared/task-contract.ts` owns the
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
  queue: {
    status: "idle" | "running" | "blocked" | "paused"; blockedBy: string | null;
    pauseReason: "cli_missing" | "plugin_missing" | "unsupported_platform" | "start_failed" | "session_not_linked" | "worktree_dirty" | null;
    order: string[];
    schedule?: { startAt: string | null; stopAfter: string | null };   // absent when neither time is set
    gates?: {                              // absent from a board that is not ready and from an older monitor
      threshold: 70 | 85 | 95;
      usage: Record<"claude" | "codex", { status: "ok" | "over" | "unknown"; fiveHourPercent: number | null; sevenDayPercent: number | null }>;
      providerStatus: Record<"claude" | "codex", "ok" | "incident" | "unknown">;
      workingTree: "clean" | "dirty" | "unknown";
      next: { taskId: string; provider: "claude" | "codex"; blockedBy: string | null; reasons: TaskGateReason[] } | null;
    };
  };
  runModels?: { codex: { id: string; label: string | null }[] };  // at most 64; empty when no catalog is committed; absent from an older monitor
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
  evidence, the planned one is intent. The Run on list offers Claude's newest observed
  model of each family and, for Codex, only `runModels.codex`: the last committed Codex
  client catalog (visible, non-alias rows) that the hourly model read already holds in
  memory. The GET never triggers a catalog read, the list is a client catalog and never
  account entitlement, and with no committed catalog Codex offers only its Default model.
  A model belongs to one provider, so a model
  without a provider is invalid; an effort alone is valid.
- `doneWhen.own` is a free-text condition that the agent judges. Pomegr does not
  evaluate it.
- `queue.order` holds task IDs only: the queued tasks that have not started, in the order
  they would start (see [Queue](#queue)). It adds no task content, and the private queue
  position never leaves the monitor.
- `queue.pauseReason` is one fixed value, set only while the queue is `paused`. It says why
  a start the queue made did not succeed and never carries a path, command, or error text.
  `worktree_dirty` says that a requeued task's own worktree holds uncommitted changes.
- `queue.gates` is the [start gates](#start-gates) as the monitor last judged them: fixed
  statuses, the whole percentages Usage limits already shows, the threshold, and for the
  next task its provider, the earlier task it waits on, and the fixed reasons that hold
  it. It never carries a path, a reset time, an incident name, a changed file, or error
  text.
- A feature is `done` when every task attached to it is done. Only unfinished
  features are offered when attaching a task.
- `session` is a borrowed, normalized reference to the bound session (see
  [Session binding](#session-binding)); it carries no transcript content. It is null
  until the session binds, then `{ id, title, state, observedModel }`, filled on every
  board that leaves the monitor by `fillTaskSessions` (`server/tasks/task-board.mjs`)
  from `resolveTaskSessionFacts`, which reads only committed memory: the session
  catalog row and the observation store's public state. `id` is the normalized
  session ID. `title` is the catalog title (the catalog's "Untitled session"
  placeholder is no title). `state` is the catalog row's `activityStatus`, the value the
  Sessions list State column renders: `working`, `needs_input`, `idle`, `open`,
  `stopped`, `closed`, or `unknown`. `observedModel` is the primary agent's latest
  reported model. The projection validates each field itself: a title that is not
  one bounded line (160 characters) is null, a state outside that list is `unknown`,
  and a model that is not a request model identifier is null. With no facts the
  session is `{ id, title: null, state: "unknown", observedModel: null }`: unknown,
  never guessed. The facts are borrowed per read and never stored.

## States

A task has seven states and no liveness. While a session works on a task, the card
shows that session's observed state, borrowed from observation. There is no Running
task state.

| State | Meaning | Set by |
| --- | --- | --- |
| Not queued | On the board, not in the queue | Creation, or removal from the queue |
| Queued | In the queue, waiting for its turn and the start gates | The user adds it to the queue, or requeues a task that needs review, is blocked, or stalled |
| Scheduled | In the queue, waiting for its own start time, then for its turn and the start gates | The user sets a start time on the task |
| Needs review | The agent reported complete but a checked condition failed | Verification of a `complete_task` report |
| Stalled | The bound session ended without a report | Observation of an established session end |
| Blocked by agent | The agent called `block_task` with a reason | The agent |
| Done | The agent reported complete and every checked condition passed, or none was checked | Verification of a `complete_task` report |

**No transient states.** Never show a state and then retract it. The state is decided
at first observation of its evidence: Stalled is assigned only once the end of the
bound session is established by committed observation, never from an idle or paused
reading that a later observation could reverse. The same rule applies to every card
badge and chip derived from a task.

Stalled is decided in `server/tasks/task-stall.mjs`. After each burst of committed
revisions the monitor reads the committed facts of every session linked to a task that
has no report. The task stalls when the catalog state is Closed; or Stopped for a Claude
Code session; or Stopped for a Codex session whose primary agent's liveness reason is
`writer_released`; or Unknown with that same reason. A Codex session reads Stopped after
a failed or interrupted turn while its process may still be present and able to report,
so Codex Stopped alone never stalls a task, and its later `complete_task` is accepted. A
Stopped state of an unrecognized provider is not an end. Idle, Open, Working, Needs
input, a bare Unknown, and a session with no committed facts leave the task as it is, so
a Codex session whose turn finished and whose state stays Idle does not stall its task.
The decision is written to the task store once. A stalled task keeps its session link
and has no report; a later report from that session is refused, and only Mark done or
Requeue changes the state. The sweep reads memory and the task store only: no provider,
Git, or GitHub read.

A linked task whose session has not reported and whose end is not established (a restart
of the computer or of Pomegr, or a cleared session, can leave it so) keeps its state.
Pomegr never marks it Done or Stalled by itself, and the queue never advances past it by
itself, because the task can matter to the whole feature; Mark done and Requeue work on
it (see [Stop on trouble](#queue)).

## Features and steps

A feature is an ordered list of steps. Tasks in the same step run in parallel, each in
its own Git worktree; a step starts only when every task of the step before it is
done. A task attached to a feature defaults to a new last step, and `step` is at least
1. Worktree creation and cleanup belong to the desktop (`task-worktree.mjs`); worktree
paths stay desktop-private and never reach the monitor store or browser state.

- **Which tasks get a worktree.** A task of a step that holds more than one task, counting
  tasks of any state. A task alone in its step, and a task without a feature, runs in the
  repository root. The monitor decides this when it answers the start plan (`worktree`,
  a boolean); it never learns where the worktree is.
- **Where.** `<desktop data root>/task-worktrees/<repository ID>/<task ID>`. Both parts are
  validated identifiers, so no task text and no repository path shapes the directory.
- **Branch.** `tasks/<task ID>`, created at the repository's current commit, or checked out
  when it already exists. Uncommitted changes of the repository root are not part of it.
- **Reuse.** A worktree left by an earlier start of the task (a requeue) is used again only
  when Git still lists it on the task branch and its working tree is clean. Otherwise the
  start fails and nothing is touched. When Git lists it on the task branch and the tree has
  uncommitted changes, the start fails with the fixed `worktree_dirty` (the manual start's
  status, and the queue's pause reason, see [Queue](#queue)); a `git status` that itself
  fails is not known to be dirty and stays an ordinary failure, `failed` for a manual start
  and `start_failed` for the queue.
- **Open folder.** The user cleans a dirty worktree by hand, so the desktop can open it:
  the fixed channel `pomegr:task-worktree-open` (see [Boundaries](#boundaries)) opens the
  task's worktree folder in the file manager, only when the folder exists and Git, asked
  from inside it, lists it on `tasks/<task ID>`. The path is resolved and opened in desktop
  main and never reaches the renderer, the monitor, the task store, a log, or a report.
  Pomegr removes nothing and still never removes a worktree that has uncommitted changes.
- **Removal.** The desktop removes a worktree only when Git lists it as a worktree of the
  repository, its working tree is clean, and its HEAD holds no commit that exists nowhere
  else (no remote and no other local branch). The removal is Git's own unforced
  `worktree remove`. The only automatic removal is of a worktree made for a start that
  then failed; the worktrees of finished tasks stay until the user removes them.
- **Git.** `execFile` with argument arrays and no shell, with a 30-second limit per call.

## Queue

The queue is the ordered set of queued and scheduled tasks, ordered by the pure `orderQueue` rule. It
is advanced only by the desktop queue runner, only after the user turned the queue on,
and only one step at a time. Every start first passes the [start gates](#start-gates).

- **Order.** `queue.order` on the board lists the IDs of the tasks that wait to start now:
  those in state `queued`, and those in state `scheduled` whose own time has come. They
  are in the order they would start, one ID per task. Features come in board order. Inside a
  feature the steps ascend, and the tasks of one step order by task number as a number
  (T-2 before T-10); they are the tasks that run in parallel. After every feature task
  come the single queued tasks, which have no feature or step. They run in the order
  they were queued, because no other order is defined for them. A task in another state
  is not in the order, even when it belongs to a queued task's feature. A task that
  already started is not in the order either: one with a linked session and no report, or
  a dispatch still inside its ten minutes (`rowInFlight` in `task-record.mjs`, which judges
  the dispatch with `dispatchStanding` from the leaf module `task-dispatch-standing.mjs`;
  the board projection and the queue share this one rule). It keeps its state and its step, so its step
  is not done, and a task of a later step waits on it (`blockedBy`). `queue.gates.next`
  never names it. The Queue view shows it with the borrowed session state, or its own chip
  until a session links, with no Waiting line, no next marker, and no move. The first
  entry is the task shown as next.
- **Queue position.** Adding a task to the queue stamps it with a private integer, one
  above the highest the repository holds. The monitor keeps it beside the task and uses
  it only to order single tasks. It is never part of a task record or of the board.
  Removing a task from the queue clears it, so queuing it again places it last.
- **Steps.** `orderQueue` also reports every step of every feature with the IDs of its
  tasks of any state and whether the step is done (it has tasks and each one is done).
  The store uses that rule to refuse a move into a done step.

- **On and off.** The stored status is per repository and starts as `idle`, which is the
  queue turned off. `queue_settings` with `{ on: true }` sets it to `running`, or to
  `blocked` with the lowest-numbered task that needs review, is stalled, or is blocked in
  `blockedBy` when one exists; `{ on: false }` sets it back to `idle`. Turning the queue
  off never touches a running session.
- **Next start.** The pure `nextQueueStart` rule in `task-queue.mjs` answers for one
  repository. Nothing starts unless the status is `running`. The queue runs one step at
  a time, and a task without a feature is a step of its own. A task is in flight when it
  has a linked session and no outcome, or a dispatch that is still live. With nothing in
  flight, the step is the one of the first entry of `queue.order`, and the starts are
  every queued task of that step, so the task shown as next is always among them. While
  tasks are in flight, only the queued rest of their own step may start; tasks in flight
  outside one feature step hold the queue. A step waits while an earlier step of its
  feature is not done, and a step is done only when every one of its tasks is done; the
  queue never skips ahead to a later task.
- **Gates.** Each start of a step is judged on its own. One that a start gate holds is
  not answered as a next start and changes nothing: the queue stays `running`, the task
  stays `queued`, and the next poll judges the gates again while the rest of its step
  starts. A held gate is a wait, not one of the outcomes that block or pause the queue.
- **Runner.** The desktop main process polls `POST /internal/tasks/queue-next` (desktop
  token, body `{}`) every 15 seconds on one unreferenced timer. The answer holds at most
  16 `{ repositoryId, taskId }` pairs, the queued tasks of the current step of each
  repository whose queue has a next start, and no task content. The runner starts them
  one after another in the same tick through the same dispatcher a manual start uses,
  without the native confirmation, because the user turned the queue on. When one start
  pauses a queue, the rest of that repository's answer is not started. A manual start and a queued start never overlap. The next start
  is served only on this route, never on `GET /api/tasks`.
- **Pause.** A start that does not succeed pauses the queue and is not retried: the
  runner posts `POST /internal/tasks/queue-pause` with `{ id, reason }`, the monitor
  stores `paused` with the task in `blockedBy` and the fixed reason (`cli_missing`,
  `plugin_missing`, `unsupported_platform`, `worktree_dirty`, or `start_failed`), and offers
  no next start until the user turns the queue on again. The runner reports a start's
  fixed status as the reason when it is one of the first four, and `start_failed` for any
  other failure; `worktree_dirty` is a requeued parallel task whose own worktree holds
  uncommitted changes, which Pomegr never removes. The user commits or discards them in
  the folder (the Queue banner's Open folder, see [Boundaries](#boundaries)) and then turns
  the queue on again. A start whose terminal opened but whose
  session never reported its token leaves an expired dispatch; the monitor pauses the
  queue on it with `session_not_linked` instead of starting the task again. Turning the
  queue on clears the reason and the repository's expired unlinked dispatches, which is
  the retry. A task that moved or a manual start in flight pauses nothing; the next poll
  asks again. The reason is kept in the store's `meta` table under
  `queue_pause_reason:<repositoryId>`, so the schema version stays 1.
- **Stop on trouble.** Any failed check (Needs review), stalled task, or agent block
  sets the queue to `blocked` with the responsible task in `blockedBy`. Nothing new
  starts until the user resolves it, by **Mark done and resume** (`resolve_done`) or
  **Requeue** (`resolve_requeue`). Sessions already running continue.
  - A report changes the stored status only of a queue that is `running`: it becomes
    `blocked`, and a queue that is already blocked keeps its first blocker. An `idle` or
    `paused` queue keeps its status; turning the queue on then computes `blocked` when any
    task needs review, is blocked, or is stalled.
  - `resolve_done` sets such a task to Done and keeps its report and session link.
    `resolve_requeue` puts it back at the end of the queue as Queued and clears its
    report, session link, and any dispatch, so a new session can be started for it and
    report once more. Either one, on a blocked queue, names the lowest-numbered task
    that still needs the user in `blockedBy`, or sets the queue back to `running` when
    none is left. Both answer `conflict` for a task in any other state.
  - **A linked task with no report.** Mark done and Requeue also accept a linked task
    whose session has not reported (a session link, state Not queued, Queued, or
    Scheduled, and no report). Pomegr never marks such a task Done or Stalled by itself,
    and the queue never advances past it by itself, because the task can matter to the
    whole feature; the user decides in the Pomegr UI, where the task panel offers **Mark
    done** and **Requeue task** with a line that neither stops the session. Neither
    action stops, attaches to, or writes to the session. Requeue clears the link, so a
    later report from the old session is `not_found`; Mark done leaves an outcome, so a
    later report is `already_reported`. A live dispatch with no linked session and a task
    that is already Done still answer `conflict`. The agent's own path is `block_task`,
    which works on such a task and blocks a running queue.
- **No stop.** Pomegr never stops a running session, whether for a schedule, a
  gate, or a blocked queue.
- **Scheduling.** A task or the queue can start at a given time, and the queue can
  stop starting tasks after a given time. Every time is one instant, stored as epoch
  milliseconds, not a daily time: the Schedule panel takes a time of day and sends its
  next occurrence, so the monitor never needs a time zone. The pure rules are
  `taskIsDue` and `queueWindowHold` in `task-queue.mjs`, and the store hands them its
  clock.
  - **A task's own time.** `queue_add` with `{ id, at }` stores `scheduled_at` and sets
    the task to `scheduled`. A scheduled task is a queued task with a start time: it keeps
    its queue position, is in `queue.order` only from its time on, and is started by the
    queue like any other task, so it needs the queue on. Until then it is not startable by
    hand either (`start-plan` answers `gate_held`). A scheduled task that is not due holds
    nothing behind it: the tasks after it start. Its feature step is not done until it
    ran, so the next step of its feature waits. The task keeps the state `scheduled` and
    its time after it started; the card then borrows the session's state.
  - **The queue's window.** `queue_settings` with `{ schedule: { startAt, stopAfter } }`
    stores the two times in the `meta` table under `queue_start_at:<repositoryId>` and
    `queue_stop_after:<repositoryId>`, so the schema version stays 1. A running queue
    answers no start before `startAt` and none from `stopAfter` on. The queue stays
    `running` and its tasks stay queued; the board names the hold on the next task as
    `before_queue_start` or `after_queue_stop`. The window holds the queue's starts only:
    a start the user makes by hand, with its native confirmation, is not held by it.
    Setting the schedule never turns the queue on or off, and turning the queue off and
    on keeps the schedule.
  - **A time that has passed.** A time is checked only when the desktop queue runner asks,
    so scheduling runs only while the desktop app is open. A task's time or a queue start
    time that passed while it was closed counts from the next question on: the start then
    happens, and only if the stop time has not come. A stop time that has passed stays
    stored and keeps holding the queue until the user changes or clears it.
  - **Bounds.** A time the user sets may be at most one minute behind the monitor's clock
    and at most 366 days ahead; anything else is `invalid`, and so is a stop time that
    does not come after the start time. A stored time that is sent back unchanged is kept
    even when it has passed, so the other time can still be edited.

## Start gates

Before every start, manual or queued, the pure `evaluateGates(task, facts, settings)` in
`task-gates.mjs` judges committed facts and returns the fixed reasons a start cannot
proceed. A start needs all of the following.

1. The previous step of the task's feature is done (`previous_step`). The board names
   the lowest-numbered task that is not done in the earliest unfinished step before it.
2. The task's provider has usage capacity: its five-hour window, as a whole percentage,
   is below the threshold (`usage_over` otherwise). The threshold is 70, 85, or 95
   percent per repository, 85 by default, set with `queue_settings` `{ threshold }` and
   kept in the store's `meta` table under `queue_gate_threshold:<repositoryId>`. The
   seven-day window is shown beside it and decides nothing. A task with no provider is
   judged as Claude Code, the provider it starts on.
3. The task's provider has no incident in the committed public provider status
   (`provider_incident`): any status but operational is an incident. Public status does
   not prove impact or causation, so it gates a start but is not shown as a cause.
4. The working tree of the repository root is clean (`tree_dirty`), by the same Git
   status rule the done-when check uses. The gate reads the root for every task, a task
   that starts in its own worktree included: a new worktree starts at the root's current
   commit, so uncommitted changes of the root would not be part of it. A worktree that
   is used again must be clean too; the desktop checks that itself and fails the start
   otherwise.

A fact that is missing, stale, or partial is unknown (`usage_unknown`,
`provider_status_unknown`, `tree_unknown`). Unknown holds a start exactly like a failed
gate and never counts as passed. The other provider's usage and status never hold a
task.

The gates read already committed facts, supplied by `resolveTaskGateFacts(repositoryId)`
in `server/runtime/task-gate-facts.mjs`:

| Fact | Source | Counts when |
| --- | --- | --- |
| Usage | The committed usage response in memory | The provider's usage is available and fresh: its own freshness when it reports one, otherwise a fetch no older than ten minutes. The reading is the highest window of that length |
| Provider status | The committed public provider status in memory | The row is ready, fresh, and not unknown |
| Working tree | A monitor-private observation of the recognized repository root, in memory only | The last inspection succeeded and is no older than 60 seconds |

No gate acquires provider data, probes an account, or runs Git on a request. Asking for
a repository's gate facts (a `GET /api/tasks`, a task action, `queue-next`, or
`start-plan`) is the demand signal for the working-tree observation: when the
observation is missing or 15 seconds old, the ask queues one asynchronous Git status of
the root and answers with what is already committed. The first ask therefore reads
unknown. At most 16 repositories are held, least recently asked first out; a repository
nobody asks about is not inspected, so there is no timer. A read whose `git status`
failed or timed out is unknown, never clean. Roots, changed files, and Git
errors stay in the monitor: only clean, dirty, or unknown leaves it.

What a held gate does:

- **Queue.** `queue-next` does not answer the start. Nothing is written, so the task
  waits and no state is shown and later retracted; `queue.gates.next.reasons` says why.
- **Manual start.** `start-plan` answers the fixed `gate_held` before a token is minted,
  after the refusals that precede it (`not_startable`, `unsupported_provider`,
  `unavailable`, `plugin_missing`). The renderer shows one fixed line that points at the
  Queue view. The queue runner treats `gate_held` like a task that moved: no pause, and
  the next poll asks again.
- **Running sessions.** Never touched.

`GET /api/tasks` serves the readings as `queue.gates`. The route rebuilds the block
field by field and drops it whole when one value is outside the contract. A monitor
runtime without the lookup serves no `gates` and holds every start.

## Completion

The agent reports through the Pomegr MCP tool `complete_task`. Pomegr then verifies
the conditions the user checked and sets the state.

| Condition | Verified by Pomegr |
| --- | --- |
| Pull request open | Committed pull-request state of the task branch |
| Working tree clean | Committed repository state of the root or worktree |
| Commit on task branch | Committed Git facts of the task branch |
| Pull request merged | Committed pull-request state |
| CI passed | Check status of the task branch's pull request, as last read by the monitor |
| Own condition | Not verified; the agent judges it in its report |

- Pass: Done. Fail: Needs review. The agent can call `block_task` with a bounded
  reason; the state becomes Blocked by agent. A session that ends without a report is
  Stalled once its end is established (see [States](#states)).
- With no condition checked, the agent's `complete_task` report alone completes the
  task.
- The report keeps only `{ check, passed }` results, the time, and the bounded block
  reason. Command output, diffs, and provider payloads are never kept or exposed.
- Verification uses committed facts and never blocks on acquisition. A fact that is
  unknown is not a pass.
- The facts are the bound session's committed public state in memory
  (`resolveTaskCheckFacts` in `server/runtime/task-session-lookup.mjs`), handed to the pure
  rule `verifyChecks(checks, facts)` as `{ treeClean, branchCommits, pullRequestStates,
  ciPassed, readAt, workAt }`. The task branch is the branch recorded for that session.
  - Working tree clean: the live repository block lists no uncommitted file.
  - Commit on task branch: the branch is not the main branch and its base comparison
    shows a commit of its own, merged since or not.
  - Pull request open, Pull request merged: the ready pull-request block holds a pull
    request whose head is the task branch in that state.
  - CI passed: the monitor's pull-request read (`server/repository/pull-requests.mjs`)
    asks gh for `statusCheckRollup` in the same call and normalizes it to one of
    `passed`, `failed`, `pending`, or `none`: any failed check gives `failed`, otherwise
    any unfinished check gives `pending`, and a pull request with no check gives `none`.
    A missing or unrecognized list is unknown. The condition judges the task branch's
    open pull requests, or its merged ones when none is open, and passes only when each
    is `passed`. Pending, failed, no check, and no such pull request are not passed; a
    pull request whose status the monitor has not read is unknown. Verification reads
    the status and the time of the read that established it from memory
    (`pullRequestCheckRead`) and never runs gh.
  - An unavailable or historical repository block, a missing base comparison, and a
    pull-request block that is not ready are unknown.
- **A fact is judged only on a read made after the work it judges.** A condition never
  passes on a fact older than the session's latest work that could have changed it. Each
  fact carries the time it was read (`readAt`) and the latest work that could have
  changed it (`workAt`), epoch milliseconds from committed memory with no clock, Git,
  GitHub, or provider read. `verifyChecks` passes a fact only when its read time is a
  finite number not earlier than its work time. A missing, malformed, or non-finite read
  time is unknown, a read earlier than the work is unknown, a null work time means no
  relevant work is recorded, and unknown is never a pass.
  - **Read times** come from monitor-private `readAt` stamps that the producers commit
    with the values they date. The repository block's `readAt` is the start of the Git
    read its changed files and base comparison come from; it dates `tree_clean` and, while
    the remote comparison is ready, `commit_on_branch`. The remote comparison's own
    `checkedAt` does not date the local read and is not used. The
    pull-request block's `readAt` is the start of the oldest read its items rest on (the
    served `checkedAt` is the newest and is not used); it dates `pr_open` and `pr_merged`.
    CI uses the oldest judged check-status read, bounded by the pull-request block's
    `readAt`. Every read is dated by the moment it began, because what it saw is no
    newer than that. Concurrent Git reads of one working tree share one inspection, and
    each caller is dated by the start of that inspection (`_readStartedAt`, a private key
    of the Git reader's answer), never by its own later call. A Git read whose
    `git status` failed or timed out (`_statusUnknown`) commits no stamp, because its empty
    file list is not a reading of the working tree. A block with no stamp (that one, a
    restored one, or a historical one) leaves its facts unknown.
  - **Work times** (`workTimes` in `task-session-lookup.mjs`). `tree_clean` is dated by
    the latest end of the session's recorded file writes and the end of every finished
    execution task, because any shell command can dirty the tree. A file write ends at
    its call time plus its recorded wall duration, not at its call: a write that waited
    for approval changes the file later than it was called.
    `commit_on_branch`, `pr_open`, `pr_merged`, and `ci_passed` are dated by the latest end
    of the session's finished `git`, `git_push`, and `pull_request` execution tasks. A task
    still running or finished at no known time, and a file write with no recorded
    result, make the matching facts unknown. A
    truncated activity feed with no file write bounds the newest write by its oldest item.
  - **Nothing new is persisted or served.** The times live in the lookup's result and the
    monitor's memory. The `readAt` stamps travel in the committed public state of a live
    session and are removed by `serializeServedSessionState`
    (`server/repository/session-repository-enrichment.mjs`), which is the observation
    store's default serializer and the `/api/state` serializer. The answer of
    `complete_task` still carries only per-condition pass or fail.
- Committed facts can trail the agent: a pull request opened seconds before the report
  may not be committed yet, and the task then needs review although the condition
  holds. The user resolves it with Mark done; the verification is not repeated.
- **Limits of the age rule, stated plainly.**
  - A report made before the next repository refresh judges an older fact, so it lands in
    Needs review even when the condition now holds.
  - A refresh enters the committed state only at the next evidence-driven derive, and an
    identical derive keeps the older stamp, so a stamp can be older than the latest read.
  - A running execution task of any kind (a dev server, for example) keeps `tree_clean`
    unknown while it runs, and a running Git, push, or pull-request task does the same for
    the four other conditions.
  - Repository work is recognized only as a finished `git`, `git_push`, or `pull_request`
    execution task. A compound or generic shell command, or another tool, that changes
    the branch or a pull request is not counted, and only the newest retained execution
    tasks are seen.
- A task takes one report per dispatch. A second `complete_task` or `block_task`, and a
  report on a task that already has an outcome, change nothing.
- The monitor serves the reports as `POST /api/agent/v1/tasks/complete` and
  `/block`, under the gate of `add`. The body is `{ sessionRef }`, plus a one-line
  `reason` of at most 200 characters for a block; any other key is `invalid`. The
  session is the only input that names a task. The answer is
  `{ schemaVersion: 1, ok: true, state, results }` (`state` is `done`, `needs_review`, or
  `blocked`; `results` only for a completion) or `{ schemaVersion: 1, ok: false, reason }`
  with `invalid` (400), `not_found` (404, no task is linked to the session),
  `already_reported` (409), or `unavailable` (503). It never carries a task ID, task
  content, or a repository fact.

## Session binding

A tool call is bound to the calling session by the harness, never by a value the model
supplies.

- **Claude Code**: a `PreToolUse` hook, like `plugins/claude-code/scripts/rename-session.mjs`,
  supplies the session on every call. The hook hands `session_ref` to `add_task`,
  `complete_task`, and `block_task` through `updatedInput`, together with `session_proof`:
  `<issuedAtMs>.<base64url HMAC-SHA256>` over the tool name, the session reference, and the
  issue time, keyed by the local agent-query capability token
  (`plugin-src/task-binding-proof.mjs`, shared by hook and server). The hook code is
  `bindClaudeQueryWrite` (async; it signs, or denies the call with a fixed text when it
  has no token or no session) and `bindClaudeQuerySession` (reads only, synchronous, and
  never binds a write tool). The token appears nowhere in the hook's output except as that
  key.
  - The Claude MCP server (`plugins/claude-code/mcp/server.mjs`) accepts a `session_ref`
    only when it has the `claude:<uuid>` shape and its proof verifies against the token read
    from the descriptor at call time: well-formed, issued at most 10 minutes ago (and at
    most 5 seconds ahead), for this tool and this session, compared in constant time.
    Anything else, including hooks disabled, a hook timeout, a model-typed `session_ref`,
    a missing, malformed, expired, other-tool, other-session, or other-token proof, or no
    readable token, answers the fixed unbound text and posts nothing. `session_ref` and
    `session_proof` are never copied into a request body, and the server never falls back
    to a launch-time session ID.
  - The window is ten minutes because the hook issues the proof before the host's
    permission prompt and the server verifies it after the user approves. This reliance on
    the hook running before the prompt has not been exercised on a device.
- **Codex**: the thread identity Codex puts in the `_meta` of every MCP tool call
  (`threadId`, which must agree with `thread_id` in its turn metadata when that is
  present), read by `resolveCodexCallSession` in `mcp/task-tools.mjs`. A stdio MCP server
  does not receive `CODEX_THREAD_ID`: Codex 0.157 starts it with an allowlisted
  environment, so that variable is only the fallback. A Codex subagent thread has its
  own identity and therefore no linked task.
- `add_task` targets the board of the task the calling session is linked to. The route
  asks the task store (`sessionTasks`, a read of the task store alone: no Git, provider,
  or path read) for the session's link first and uses the linked task's repository ID; the
  session's committed repository identity is used only when the session is not linked or
  the store cannot answer. So a session started in a task worktree adds to the repository
  whose board holds the task, even when its committed identity differs, is missing, or is
  not committed yet. It never accepts a path or a repository ID.
- The monitor serves `add_task` as `POST /api/agent/v1/tasks/add`, beside the agent-query
  GETs and under the same gate: loopback host, no `Origin` header, and the agent token
  when one is configured. The body is a JSON object of at most 16 KiB with
  `Content-Type: application/json` and only these keys: `sessionRef` (`claude:<id>` or
  `codex:<id>`), `text`, and optionally `run`, `doneWhen`, and `feature` (a feature name).
  Any other key, including a repository ID or path, is `invalid`. The record rules are
  the store's. The monitor resolves `sessionRef` to a repository from the task link or, for
  a session without one, from the session's committed repository identity, never reading
  Git or provider files, and creates the task as the desktop `create` action does: last in the first column, not queued. A `feature` must
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
  linked to the bound session. Both plugins run the same hook script on `startup` only;
  the Codex plugin passes `--provider codex` and sends `codex:<session_id>`. The session
  ID always comes from the hook input. Codex replays its launch environment into hook
  commands but starts a stdio MCP server with an allowlisted environment, so the token
  reaches the hook and never the Codex MCP server.
- The monitor serves the link as `POST /api/agent/v1/tasks/bind`, under the same gate and
  with the same content-type and size checks as `add`. The body is a JSON object of at
  most 1 KiB with exactly `token` (the dispatch token) and `sessionRef` (the normalized
  session ID, `claude:<id>` or `codex:<id>`). The token is the only authority: the
  catalog has no row for the session yet at session start, so the session is not looked
  up. The lookup is monitor-wide, by the SHA-256 digest of the token over every unlinked
  dispatch. In one write transaction the store sets the task's session, clears the
  digest, and bumps the update time. It changes no state, column, or queue position.
- The link is single assignment. A wrong or reused token, an unbound dispatch older than
  ten minutes, a task that already has a session, and a session already linked to
  another task all answer the same `not_found`, so the answer never says which failed.
  The `tasks_session` unique index is the last guard. A linked task is never startable
  again, and its link never expires.
- The answer is `{ schemaVersion: 1, ok: true }` or `{ schemaVersion: 1, ok: false,
  reason }` with `invalid` (400, including a malformed token or session ID), `not_found`
  (404), or `unavailable` (503). It carries no task ID, repository ID, or task content.
- The token is a secret shared with the started process. It never reaches browser
  state, logs, reports, or notifications.

A session that was not started from a task has no linked task; its tools can still add
tasks to its repository. A session that is not linked, but that the user opened inside a
task worktree, still resolves to the worktree's own committed identity, because no
committed fact maps it to the repository whose board holds the task (see
[Known defects](#known-defects)).

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
   the repository, a gate holds (fixed result `gate_held`), a worktree reused for the
   task has uncommitted changes (fixed result `worktree_dirty`), or the platform is not
   Windows (fixed result `unsupported_platform`).

Built so far: the manual and the queued start of a Claude Code or Codex session behind the start gates, and the link of the started session to its task.

- The renderer calls the fixed IPC channel `pomegr:task-start` with a repository ID and a
  task ID. It gets back one fixed status and nothing else: `started`, `cancelled`,
  `unsupported_platform`, `cli_missing`, `plugin_missing`, `not_startable`, `gate_held`,
  `unsupported_provider`, `not_found`, `busy`, `invalid`, `unavailable`, `failed`, or
  `worktree_dirty`.
- Desktop main checks the platform and looks for the Claude Code and Codex executables,
  then shows the native confirmation, which names only the task ID. Only after the user
  confirms does it ask the monitor for the start plan, because the plan mints a
  single-use token. The provider is therefore known only from the plan: with no provider
  executable installed the start answers `cli_missing` before the confirmation, and when
  the plan's own provider executable is missing desktop main aborts the dispatch and
  answers `cli_missing`.
- `POST /internal/tasks/start-plan` answers the plan for a startable task: provider,
  model, effort, the repository root resolved monitor-side, whether the session must run
  in a worktree of its own (`worktree`), the prompt, and the dispatch token. A task is startable when its state is `not_queued`, `queued`, or `scheduled`, no
  session is linked, and no dispatch is live. A task with no provider starts Claude Code;
  a Codex task starts Codex, and any other provider value answers
  `unsupported_provider`. The monitor refuses with `plugin_missing` unless the committed
  plugin setup of the repository shows the Pomegr plugin of that provider installed,
  ready, and enabled, and with `unavailable` when it has not identified the
  repository's root in the current run. Last, it refuses with `gate_held` when a
  [start gate](#start-gates) holds the task.
- The monitor stores only the SHA-256 digest of the token and its mint time. An unbound
  dispatch is live for ten minutes; after that the task can be started again. The
  session's first report of the token binds it (see [Session binding](#session-binding)),
  which discards the digest and ends the expiry.
- Desktop main validates the plan, then opens the terminal through one fixed PowerShell
  command (`Start-Process`), run with `spawn`, an argument array, and `shell: false`. A
  detached child of a windowless app gets no console, so the executable cannot be
  spawned directly. The command line is constant: the executable, its argument string,
  and the directory travel only as environment variables, which PowerShell reads as
  values and never parses as script, and which are removed before the session starts.
  The argument string holds the model and effort flags only when set, followed by the
  prompt as one argument, each quoted by the Windows command-line rules. Claude Code
  takes `--model` and `--effort`; Codex takes `--model` and
  `-c model_reasoning_effort=<effort>`, and accepts each task effort by name, `xhigh`
  included. The environment is the user's own, as the desktop app inherited it at launch
  (product-owner decision, 2026-10-09): the session's hooks and MCP servers need the
  user's Node, tools, and settings, so the app's stripped runtime environment is not
  used. Left out are only the app's own variables (`ELECTRON_*`, `POMEGR_SMOKE_*`,
  `POMEGR_START_*`, the monitor origin and token); added is `POMEGR_TASK_TOKEN`. A
  provider folder variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) is set only when the user
  chose that folder in Settings or inherited the variable: naming the default folder makes
  Claude Code read another user configuration file. Pomegr keeps no handle to the session.
- When the plan is malformed, its provider executable is missing, or the launcher fails or does not end within 15 seconds,
  desktop main calls
  `POST /internal/tasks/start-abort` with the token, which clears the matching dispatch.
- Starting never changes the task's state, column, or queue position.
- After a manual start answers `worktree_dirty`, the task panel shows **Open folder**. It
  calls the fixed channel `pomegr:task-worktree-open` with the repository ID and task ID
  only and shows one line per fixed result (`opened`, `not_found`, `invalid`,
  `unavailable`); the **Queue paused** banner offers the same button when the pause reason
  is `worktree_dirty`. Desktop main resolves the folder (the task's worktree directory,
  which must exist and be listed by Git on the task branch) and opens it with
  `shell.openPath`; Windows only. No path, command, or error text crosses the channel.

Claude Code and Codex are both startable. Pomegr never attaches to, writes input to,
approves for, or stops the started process; afterwards it only observes the session
like any other.

## Boundaries

| Surface | Who | What it carries |
| --- | --- | --- |
| `GET /api/tasks?repositoryId=repo-<24 hex>` | A same-computer client, gated like `GET /api/provider-folders`; not on the LAN gateway list | The committed board, `no-store`, with each linked session's borrowed title, state, and model. A denied client gets `readiness: "desktop_only"` and no task content |
| `GET /api/sessions?mode=directory` with the proxy's `tasks=1` marker | A same-computer client; the LAN gateway forwards the path but marks its requests, and a marked request never gets the marker | Each row's nullable `task` (task ID, board repository ID, outcome state or null, feature ID, feature name, step), the `feature` scope, `group=feature`, and the `session` scope (one validated session ID, no other scope beside it) that the session view uses to read its own row. Without the marker: `taskReadiness: "desktop_only"`, no `task` key, and a feature scope matches no session |
| `pomegr:task-action` IPC | The renderer, through a trusted main frame only | A fixed action name, the repository ID pattern, and a payload of at most 16 KiB |
| `POST /internal/tasks/<action>` | Desktop main, with the desktop token | The same action; the monitor validates the whole record |
| `pomegr:task-start` IPC | The renderer, through a trusted main frame only, behind a native confirmation | A repository ID and a task ID; answers one fixed status |
| `pomegr:task-worktree-open` IPC | The renderer, through a trusted main frame only (the task panel's and the Queue banner's **Open folder**) | A repository ID and a task ID; answers one fixed status (`opened`, `not_found`, `invalid`, `unavailable`). Desktop main resolves and opens the worktree folder; the path never leaves it |
| `POST /internal/tasks/start-plan` and `start-abort` | Desktop main, with the desktop token; not reachable through `pomegr:task-action` | The start plan with the repository root, prompt, and dispatch token; none of them reaches the renderer or `GET /api/tasks` |
| `POST /internal/tasks/queue-next` and `queue-pause` | The desktop queue runner, with the desktop token; not reachable through `pomegr:task-action` | At most 16 `{ repositoryId, taskId }` next starts, and a fixed pause reason in; no task content either way |
| `POST /api/agent/v1/tasks/add\|complete\|block` | An agent through the MCP tools, authorized like the agent-query GETs | The only agent writes of the tools. `complete` and `block` carry the bound session and, for a block, the reason; they answer the resulting state and per-condition pass or fail |
| `POST /api/agent/v1/tasks/bind` | The plugin's session-start hook, authorized like the agent-query GETs | The dispatch token and the normalized session ID; answers a fixed object with no task data. Not an MCP tool; no other path may be added without updating the AGENTS.md rule |

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
  `queue_add` takes `{ id }` and, optionally, `at`, an instant written as
  `2026-10-09T02:00:00.000Z`. Without `at`, a task in state `not_queued` becomes `queued`
  at the end of the queue, and a `scheduled` task becomes `queued` in the place it has and
  loses its time; any other state is `conflict`. With `at`, a task in state `not_queued`,
  `queued`, or `scheduled` with no linked session becomes `scheduled` with that time, in
  the place it has or at the end; a task with a session or an outcome is `conflict`, and a
  time outside the bounds is `invalid`. An unknown task is `not_found`. `queue_remove`
  takes exactly `{ id }`: a `queued` or `scheduled` task becomes `not_queued` and loses
  its time; any other state is `conflict`. `resolve_requeue` clears the time too.
  `queue_reorder` takes exactly `{ id, step }` with `step` an integer of at least 1. The task
  must exist (`not_found`) and be queued and in a feature (otherwise `conflict`; a single
  task is not reordered). `step` is valid from 1 to the feature's highest step + 1, measured
  before the move, where the highest + 1 is a new last step; anything else is `invalid`. A
  target step whose tasks are all done answers `conflict`. Moving a task to its own step, or
  the only task of the last step to a new last step, succeeds and changes nothing. Otherwise
  the steps are renumbered densely in the same transaction (a step the move empties
  disappears) without changing the update time of other tasks, and the task stays
  `queued`. The three actions start no session and leave the stored queue status as it is.
  There is no insertion of a step between two others yet. `resolve_done` and
  `resolve_requeue` take `{ id }` (see [Queue](#queue)). `queue_settings` takes
  exactly one setting: `{ on }`, a boolean (see [Queue](#queue)); `{ threshold }`,
  one of 70, 85, and 95 (see [Start gates](#start-gates)); or `{ schedule }`, exactly
  `{ startAt, stopAfter }` with each an instant or null (see Scheduling under
  [Queue](#queue)). The last two leave the queue status as it is.
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
  triggers observation. Its session facts come from a lookup that reads memory only, and
  the `/internal/tasks/<action>` answers carry the same filled board.
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
  and step. That is a deliberate widening of exposure: the part that builds it updates
  the AGENTS.md rule in the same pull request, and it must not carry task text, the own
  condition, or a column name.
- The Sessions list part has shipped. `server/tasks/task-session-link.mjs` reads the
  reference, and `server/serving/session-directory-tasks.mjs` joins it onto a directory
  page when the page is served. It adds the ID of the repository whose board holds the
  task, so the task ID can link to that board (a task worktree gives the session another
  repository ID), and the opaque feature ID, which the Feature filter passes back. The
  state is served only as `needs_review`, `stalled`, `blocked`, `done`, or null; the list
  draws a chip for Needs review, Stalled, and Done, and none for Blocked by agent.
- The session view part has shipped with no new projection. The session view asks the same
  directory read for its own row (`session=<normalized session ID>`), so it gets the same
  reference, the same gate, and nothing on `/api/state` or a session domain. The scope is a
  session ID, not task data: it narrows the page for every client, and a client without
  the marker still gets no `task` key. The header, the Overview task row, and the Task tab
  then read the task itself from `GET /api/tasks` for the reference's repository
  (`app/session-task-store.ts`, `app/components/dashboard/SessionTaskSummary.tsx`,
  `SessionTaskTab.tsx`). While that board is not ready they show only the reference's ID,
  state, feature, and step. The Task tab is listed only once the reference is known, so it
  is never shown and then removed; it mutates nothing.
- A session's task reference is found by the session link, never by repository ID. The
  session catalog stores none of it: the catalog index only takes a bounded set of
  session IDs to narrow or group a page.
- Grouping by feature lists only sessions started for a task that belongs to a feature,
  from at most the 2000 newest links. A session with no task, or with a task outside a
  feature, is in no group.
- Task references follow the `GET /api/tasks` gate. The LAN gateway forwards
  `/api/sessions` with a loopback host, so it marks every forwarded request with
  `x-pomegr-lan-gateway`, and the same-origin proxy never sets `tasks=1` on a marked
  request. The development server marks a peer that is not local the same way, because
  it listens on the LAN and a peer can send any Host header. A client without the marker gets `taskReadiness: "desktop_only"`: the list
  has no Task column, and Group by Feature says where features are shown.
- Task state shown beside a session is a projection of the task store, never an
  observation of the session.
- Provider and model names, effort, check results, and times are normalized enums or
  identifiers, not user content.
- The pull-request check status is monitor-private. It is held only in memory, as one
  fixed `passed`, `failed`, `pending`, or `none` value together with the time of the read
  that established it, for at most 256 pull-request URLs, and it is not part of the
  normalized pull-request item. It is never persisted and never enters `/api/state`, a
  session domain, a repository snapshot, a report, a log, or `GET /api/tasks`. Its only
  use is the CI passed condition, which exposes pass or fail, and the time only refuses a
  pass on a fact read before the session's latest relevant work. Check names, URLs,
  conclusions, and counts are dropped when the list is normalized.
- The committed repository and pull-request blocks of a live session state also carry a
  monitor-private `readAt` (the start of the Git read, and the start of the oldest
  pull-request read). The session-state serializer removes them before any serving, and
  they never appear on `/api/state`, a session domain, a repository snapshot or sidecar, a
  checkpoint, a report, a log, or `GET /api/tasks`. The ownership note is in the
  [observation cache](observation-cache.md).

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

## Open questions and unassigned work

Each item is owned by the product owner; none is implemented until they answer.

1. **Report-less completion.** May a deterministic condition, for example the pull
   request being merged, complete a task when the agent never reported? Do not
   implement it; a session that ended without a report is Stalled, and a task whose
   session has not reported waits for the user.
2. **Browser read.** Should the same-computer browser keep reading `GET /api/tasks`, or
   should the board be desktop only? Until answered, the read follows the
   `GET /api/provider-folders` gate and exposes nothing to the LAN. The same answer
   decides whether a paired LAN client may ever see task references on the Sessions
   list and in the session view.
3. **Product wording.** The root README, `PRODUCT.md`, the package description, the
   plugin readmes, the landing pages, the public settings guide, the tray tooltip and
   its test, and the
   [product positioning decision](../decisions/product-positioning.md) still call
   Pomegr a read-only observer. Observation is read-only; the product now also starts
   sessions. No delivered change owned those files.
4. **Board deep links.** The board has no address for the Queue view or one task, so
   feature links and Open on board in the session view open the board only, and a task
   ID on the Sessions list opens the board instead of the session's Task tab.
5. **Session start outside Windows.** Other platforms answer the fixed
   `unsupported_platform` result until a launcher is validated for them.

## Known defects

The acceptance review of 2026-10-08 passed the privacy, mutation, spawn, and binding
rules and reported seven defects. The follow-up of 2026-10-09 fixed them, and the sections
above now describe the fixed behavior. The first run on a device, on 2026-10-09, found
three more. Five items remain open, and the maintainer owns each. The stated limits of the age rule for done-when conditions are listed under
[Completion](#completion).

1. **`add_task` from an unlinked session in a task worktree targets another board.** A
   session the user opened by hand inside a task worktree still resolves to the
   worktree's own committed identity (the Git top level), because no committed fact maps
   it to the repository whose board holds the task. A session started for a task adds to
   the right board.
2. **A started task without a feature holds every start, but `queue.gates.next` does not
   say so.** A started task with no feature is a step of its own that holds the queue,
   yet `queue.gates.next` still names the next queued single task with no hold reason, so
   the Queue view shows **Queued · next** on a task that does not start. A pinned test
   keeps this behavior. A fixed reason such as `task_running` would widen the
   [AGENTS.md](../../../AGENTS.md) rule, so it is not added until the product owner
   decides.
3. **The start gate does not check the plugin's version.** A start needs the Pomegr plugin
   installed and enabled, but not a version that has the bind hook and the task tools
   (0.9.0 or later). With an older plugin the session starts, never links, and the card
   keeps its own chip.
4. **The task panel keeps its start line after the task changes.** After a start the panel
   shows "Session started in a new terminal window." and keeps Start session disabled for
   as long as it stays open, also after Requeue or after the task is done. Closing and
   opening the panel clears it.
5. **A held manual start does not say which gate holds.** The panel reads "A start gate
   holds this task. See Start gates in the Queue view." although the fixed hold reasons
   are already served on `GET /api/tasks`.

Proven on a device on 2026-10-09 (Windows, Claude Code, plugin 0.9.0): a started session
opens as the user's own Claude Code, in the repository root and in a new task worktree;
it links to its task; `complete_task` and `add_task` are accepted with the hook's proof;
Mark done and Requeue work on a linked task with no report and leave the session running,
and the requeued session's later report is refused; a started task is not the queue's next
task; a dirty task worktree refuses a manual start and pauses the queue with
`worktree_dirty`, and Open folder opens it.

Not yet proven on a device: that Codex sends the thread identity the binding reads, a
Codex session start, the Stalled state after a real session end, a checked done-when
condition, and a tool call that waits at a permission prompt inside the proof window.

## Change and verify

Route the change with the [agent workflow](../development/agent-workflow.md), then run
the focused commands of the owning row. A change that adds a field, route, tool, or
surface to the task data class updates the AGENTS.md rule, this page, and the
[user guide](../../public/using-pomegr/tasks.md) together. `server/tasks/` has its own
layer rule (`server-tasks-layer`) in `.dependency-cruiser.cjs`. Run
`npm run check:boundaries` for import direction and `npm run check:docs` for this
page.
