# Task board and session dispatch

> Scope: the per-repository task board, the queue that starts sessions for its tasks,
> and the agent tools that add, remove, complete, and block tasks, that assign a session
> to a task, and that read and change features. It does not cover
> observation, which stays read-only and is owned by the
> [observation cache](observation-cache.md).
> Authority: canonical design contract for tasks and dispatch, decided by the product
> owner on 2026-10-08. This page is the canonical owner of the task privacy invariants
> (its [Privacy](#privacy) section). A change that widens exposure changes the Privacy
> section in the same pull request. The executable contract `shared/task-contract.ts`
> wins on exact field shapes. Repository-wide rules are in
> [AGENTS.md](../../../AGENTS.md).
> Related code and checks: the owners and focused commands are routed in the
> [agent workflow](../development/agent-workflow.md).

**Status: built.** Every capability on this page has shipped: the board, features,
parallel groups, the queue with its start gates and schedule, session start for Claude Code and
Codex on Windows, session binding, assigned sessions, the thirteen agent tools, verified
conditions, and the task reference on the Sessions list and in the session view. The user guide is
[Tasks](../../public/using-pomegr/tasks.md). Report-less completion (a task finishing
from a deterministic condition with no agent report) is deliberately not designed or
implemented; see [Open questions and unassigned work](#open-questions-and-unassigned-work).

Pomegr is an observer plus an opt-in dispatcher. Observation is unchanged: it
reads provider data and never writes it. Tasks and dispatch are a separate control
plane that lets the user queue work for a repository and have Pomegr start a new
Claude Code or Codex session for it on the desktop computer. A paired device may read
the board, send the fixed task actions, and confirm a manual start on that computer
(see [Paired devices](#paired-devices)).

## Ownership

The control plane has its own owners. Observation modules never import them, and
they never import observation internals beyond the shared value primitives.

| Owner | Responsibility | May not import |
| --- | --- | --- |
| `server/tasks/` | Task store, record validation, board projection, queue rules, complete-when checks, start gates | `server/runtime/` or `server/serving/` (dependency-cruiser rule `only-entry-points-import-runtime-and-serving`); the `server-tasks-layer` rule limits it to `server/tasks/`, `server/normalize/`, and `server/persistence/` |
| `server/serving/task-routes.mjs` | HTTP for tasks, called from the request handler (pattern: `notification-routes.mjs`) | Task rules; it only parses, authorizes, and delegates |
| `shared/task-contract.ts` | Browser-visible types and bounds | Anything from `server/` or `desktop/` |
| `desktop/runtime/task-*.mjs` | Trusted IPC, session start, queue runner, worktrees | The renderer; `server/` internals (the monitor is reached over its internal HTTP) |
| `app/components/tasks/`, `app/tasks-store.ts`, `app/tasks-home-store.ts`, `app/api/tasks/route.ts` | Presentation and the same-origin proxy | Credentials, raw session files, the store, any mutation path |
| `mcp/task-tools.mjs` and `plugin-src/` | Agent tools; never hand-edit `plugins/**` bundles, edit sources and run `npm run build:plugin` | `desktop/`; `server/` beyond the shared normalizers |

The pure rule modules take plain records and return plain values, with no store,
route, or Git access: `orderQueue(tasks)` in `task-queue.mjs`,
`explainQueueWaits(input)` in `task-queue-waits.mjs`,
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
- Bounds per repository: 500 tasks and 50 features. Task text is at most 4000
  characters, an own condition 500, a feature name 80, a feature description 2000, a
  feature app version 40, a block reason 200, and an attention line 200. A task holds at most four images of at most 5 MiB each (see
  [Images](#images)). A board
  always has five columns (see [Columns and card moves](#columns-and-card-moves)).
- `openTaskStore({ directory })` returns `readBoard(repositoryId)`,
  `apply(repositoryId, action, payload)`, and `close()`. `apply` returns the new board
  or a fixed error: `invalid`, `not_found`, `limit`, `conflict`, or `unsupported`. A new
  capability adds an action, not a method.
- The first read of a repository seeds the five columns: Backlog, Ready, In progress,
  Review, and Done. The last three carry the column roles `in_progress`, `review`, and
  `done` (see [Columns and card moves](#columns-and-card-moves)).
- A store made before the columns were fixed is brought to the five in one store
  write (see [Boards made before the fixed columns](#boards-made-before-the-fixed-columns)).
- A column's role is kept in the store's `meta` table under
  `column_role:<repositoryId>:<role>` with the column ID as the value, like the pause
  reason, so the schema version does not change.
- Whether a task asks for Remote Control is kept there too, under
  `task_remote_control:<repositoryId>:<taskId>` with the fixed value `1`
  (`server/tasks/task-remote-control.mjs`). The row exists only while the flag is on:
  it is written in the write that creates or updates the task and removed when an
  update turns it off or the task is deleted. A row left on a Codex task reads as off.
- Whether a done task keeps its worktree is kept there too
  (`server/tasks/task-worktree-cleanup.mjs`). Removing it is the default, so
  `task_keep_worktree:<repositoryId>:<taskId>` exists, with the fixed value `1`, only for a
  task that keeps it. `task_worktree_cleanup:<repositoryId>:<taskId>`, also `1`, exists
  from the write that marks such a task done until the desktop reports the worktree gone
  (see [Worktrees](#worktrees)). Both go in the write that deletes the
  task.
- A task's parallel group is kept there too, under
  `task_group:<repositoryId>:<taskId>` with the group ID (`grp-<12 hex>`) as the value
  (`server/tasks/task-groups.mjs`). A row exists only while the task counts as a member
  of a group (see [Parallel groups](#parallel-groups)). It goes in the write that deletes
  the task, and `pruneTaskGroups` removes the rows of a task whose membership no longer
  counts and of a task left alone in its group.
- What a task runs after is kept there too, under `task_after:<repositoryId>:<taskId>`
  with a JSON list of 1 to 8 task IDs of the same board as the value
  (`server/tasks/task-after.mjs`, task T-101). The row exists only while the list is not
  empty. The write that deletes a task removes its own row and takes its ID out of every
  other list, so no list names a task that is gone (see [Runs after](#runs-after)). A
  stored list outside the contract reads as no list.
- Whether a repository was brought from feature steps to parallel groups is kept there
  too, under `ready_groups:<repositoryId>` with the fixed value `1`. A repository that
  the store creates is marked at creation (see
  [Boards made before parallel groups](#boards-made-before-parallel-groups)).
- The `tasks.step` column stays in the schema, so the schema version stays 1. Nothing
  reads it. It is written `1` for a task of a feature and NULL for any other task.
- The session that added a task through `add_task` is kept there too, under
  `task_added_by:<repositoryId>:<taskId>` with the normalized session ID as the value
  (`server/tasks/task-adder.mjs`). It is written in the write that creates the task and
  removed in the one that deletes it, and it is never projected onto a board (see
  [Agent task removal](#agent-task-removal)).

- The sessions assigned to a task are kept there too, under
  `task_assigned:<repositoryId>:<taskId>` with a JSON list of normalized session IDs as
  the value, in the order they were assigned (`server/tasks/task-assignments.mjs`). The
  row exists only while the task holds an assigned session, and it goes in the write that
  deletes the task (see [Assigned sessions](#assigned-sessions)).

- A feature's description and app version are kept there too, under
  `feature_description:<repositoryId>:<featureId>` and
  `feature_app_version:<repositoryId>:<featureId>` (`server/tasks/task-feature-details.mjs`).
  A row exists only while the field is set, and both go in the write that deletes the
  feature. Neither is projected onto a board (see [Feature context](#feature-context)).
- A feature the owner marked done is kept there too, under
  `feature_done:<repositoryId>:<featureId>` with the fixed value `1`
  (`server/tasks/task-feature-details.mjs`). The row exists only while the feature is
  done, and it goes in the write that deletes the feature. A store with no such row, an
  older one included, reads every feature as not done; it needs no schema change and no
  migration step (see [Done features](#done-features)).

## Record

The browser-visible shape follows. `shared/task-contract.ts` owns the
executable version.

```ts
type TaskCheck = "pr_open" | "tree_clean" | "commit_on_branch" | "pr_merged" | "ci_passed" | "user_validated";
type TaskState = "not_queued" | "queued" | "scheduled" | "needs_review" | "stalled" | "blocked" | "done";
type Task = {
  id: string;                 // "T-<n>", monotonic per repository
  text: string;
  columnId: string; position: number;
  featureId: string | null;
  group: string | null;       // "grp-<12 hex>": the parallel group of a task that has not finished its turn, or null
  after?: string[];           // the tasks of the same board it runs after; absent means none
  run: { provider: "claude" | "codex" | null; model: string | null; effort: "low" | "medium" | "high" | "xhigh" | null;
    remoteControl?: boolean;                           // Claude Code only; absent from an older monitor, which means off
    keepWorktree?: boolean };                          // present only when on; absent means the worktree is removed when done
  completeWhen: { checks: TaskCheck[]; own: string | null };
  state: TaskState;
  scheduledAt: string | null;
  session: { id: string; title: string | null; state: string; observedModel: string | null;
    checks?: { check: TaskCheck; passed: boolean }[] } | null;
  assigned?: { id: string; title: string | null; state: string; observedModel: string | null }[];  // absent means none
  report: { at: string; results: { check: TaskCheck; passed: boolean; unavailable?: true }[];   // `unavailable`: not verified
    blockReason: string | null;
    attention: string | null } | null;                 // what the agent asked the owner to look at
  source: { kind: "github_issue"; number: number } | null;   // set once, by a promote or an issue create
  images?: { id: string; type: "png" | "jpeg" | "gif" | "webp"; bytes: number }[];   // at most four; never the bytes
  createdAt: string; updatedAt: string;
};
type TaskBoard = {
  version: 1; readiness: "ready" | "loading" | "unavailable" | "desktop_only";
  repositoryId: string;
  columns: { id: string; name: string; position: number; role: "in_progress" | "review" | "done" | null }[];
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
    waits?: {                              // absent when no task waits, and from an older monitor
      taskId: string; place: number | null;
      reasons: { reason: TaskQueueWaitReason; taskIds: string[]; more: number }[];
    }[];
  };
  runModels?: { codex: { id: string; label: string | null }[] };  // at most 64; empty when no catalog is committed; absent from an older monitor
};
```

- A task is created with one free-text field, **Task**. There is no title field: a card
  shows the task text until its session has a title, then the session title. A new task
  always lands in the first column.
- The New task modal, for a written task and for a promoted issue, opens with the `run`
  and `completeWhen` of the newest task on the board, the one with the highest ID, and
  with no feature. An empty board gives the default `run` (Claude Code, its Default
  model, effort `medium`) and the checks Pull request open and Working tree clean. This
  is read from the board the client already holds: nothing is kept in browser storage,
  and an `add_task` task counts as the newest like any other.
- Run on and Effort are required in the task forms. A new task opens with both chosen:
  the form fills a provider or an effort that the newest task lacks from the default
  `run`. Run on offers no "Not set", and pressing the chosen effort keeps it, so neither
  can be cleared. The New task and promote forms therefore always send a `run` with a
  provider and an effort. Only the forms require them: the monitor still accepts a `run`
  with a part missing, because an `add_task` task and a task stored before this rule may
  have none. The Task form shows such a task as stored, with "Not set" in Run on or no
  pressed effort, until the user chooses one; after that it cannot go back.
- `run` sets only the main agent of the started session, and the monitor treats every
  part of it as optional: a provider with a model or its "Default model", and an effort. `model` is
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
- `run.remoteControl` asks that the task's Claude Code session start with Remote
  Control on, so its owner can also reach it from another device (see
  [Starting a session](#starting-a-session)). It is one boolean, off when absent, and
  valid alone. Pomegr does not enable Remote Control for Codex tasks, so `true` on a Codex task is invalid, in
  the desktop actions and in `add_task` alike. Only the `create` and `update` actions
  and `add_task` set it; `update_task` only turns it off, when it moves a task to Codex. The `add_task` tool takes it as the optional input
  `remote_control`, a boolean and nothing else.
  Codex offers [Remote access](https://developers.openai.com/blog/mastering-codex-remote-for-engineering), but its experimental CLI command manages a shared app-server daemon.
  Pomegr does not start or pair that daemon; task forms hide the checkbox for Codex.
- `run.keepWorktree` says that the task's own worktree and branch stay when the task is
  marked done. It is one boolean, on the run only when it is `true`: removing them is the
  default (task T-27, product-owner decision of 2026-10-11), and the task forms show it as
  the checked box **Remove worktree and branch when done**. It is valid alone and on
  either provider. Only the `create` and `update` actions set it; `add_task` has no input
  for it, so an agent's task removes its worktree. A new task never takes it from the
  newest task on the board. It changes nothing for a task that runs in the repository
  root (see [Worktrees](#worktrees)).
- `completeWhen.own` is a free-text condition that the agent judges. Pomegr does not
  evaluate it.
- `queue.order` holds task IDs only: the queued tasks that have not started, in the order
  they would start (see [Queue](#queue)). It adds no task content. The waiting cards of
  the Ready column read in this same order.
- `group` is the opaque ID of the task's parallel group, or `null` (see
  [Parallel groups](#parallel-groups)). It replaces the earlier `step`, which no contract
  carries any more. It is not null only while two or more members whose membership counts
  share the group: tasks in the queue (Queued or Scheduled, waiting or in flight) and
  planned tasks (Not queued, not started, with the card in Backlog or Ready). A task left
  alone in its group reads `null`. It holds no task content.
- `after` lists the IDs of the tasks of the same board the task runs after, in the order
  the owner set them (see [Runs after](#runs-after)). It is absent when the task runs after
  none, and it never names a task that is not on the board. It holds no task content: the
  board already serves each named task.
- `queue.pauseReason` is one fixed value, set only while the queue is `paused`. It says why
  a start the queue made did not succeed and never carries a path, command, or error text.
  `worktree_dirty` says that a requeued task's own worktree holds uncommitted changes.
- `queue.blockedBy` is the ID of a task on the same board, or `null`. A stored blocker
  that names no stored task is served as `null`, never as a task ID.
- `queue.gates` is the [start gates](#start-gates) as the monitor last judged them: fixed
  statuses, the whole percentages Usage limits already shows, the threshold, and for the
  next task (the first task `nextQueueStart` would start: a waiting due member of the
  group in flight, otherwise the first entry of `queue.order`) its provider, the earlier task it waits on (`blockedBy`: the lowest-numbered
  task in flight that is not in the next task's own group, by task ID only), and the fixed
  reasons that hold it, `earlier_task` among them. It never carries a path, a reset time,
  an incident name, a changed file, or error text.
- `queue.waits` says, for each task that waits in the queue, where it stands in the start
  order and why it has not started (see [Why a task waits](#why-a-task-waits)): a task
  ID, a place, fixed reasons, and for a reason the IDs of at most eight tasks of the
  same board. It adds no task content, path, time, percentage, or error text.
- A feature is `done` when the owner marked it done (see [Done features](#done-features)).
  Only features that are not done are offered when attaching a task. A board feature is `{ id, name, done }`:
  `name` is the feature's title, and its description and app version are not on the
  board (see [Feature context](#feature-context)).
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
- `assigned` lists the sessions assigned to the task, in the order they were assigned
  (see [Assigned sessions](#assigned-sessions)). Each entry is the same borrowed
  reference as `session`, filled from the same committed facts by `fillTaskSessions`
  and validated the same way, with no `checks` reading. It is absent from a task that
  holds none and from an older monitor. It never lists the session Pomegr started for
  the task, and it holds at most 16 entries.
- `images` lists the task's images in the order they were attached: an opaque ID
  (`img-<12 hex>`), the fixed type the monitor read from the bytes, and the size in
  bytes. It never carries image bytes, a file name, or a path (see [Images](#images)).
  It is absent from an older monitor, which means none.
- `session.checks` is the monitor's reading of the checked conditions of a task that
  waits for its report (see [Completion](#completion)). It is absent from every other
  task.

## States

A task has seven states and no liveness. While a session works on a task, the card
shows that session's observed state, borrowed from observation. There is no Running
task state.

| State | Meaning | Set by |
| --- | --- | --- |
| Not queued | On the board, not in the queue | Creation, or removal from the queue |
| Queued | In the queue, waiting for its turn and the start gates | The user adds it to the queue, or requeues a task that needs review, is blocked, or stalled |
| Scheduled | In the queue, waiting for its own start time, then for its turn and the start gates | The user sets a start time on the task |
| Needs review | The agent reported complete; the report holds each checked condition's result and the optional attention line | Verification of a `complete_task` report |
| Stalled | The bound session ended without a report | Observation of an established session end; it leaves when that session reports or is confirmed live again |
| Blocked by agent | The agent called `block_task` with a reason | The agent |
| Done | The owner accepted the task | The user's Mark done (`resolve_done`) |

**No transient states.** Never show a state and then retract it. The state is decided
at first observation of its evidence: Stalled is assigned only once the end of the
bound session is established by committed observation, never from an idle or paused
reading that a later observation could reverse. The same rule applies to every card
badge and chip derived from a task.

Stalled is decided in `server/tasks/task-stall.mjs`. After each burst of committed
revisions the monitor reads the committed facts of every session linked to a task that
has no report. A session reads as ended when the catalog state is Closed; or Stopped for a Claude
Code session; or Stopped for a Codex session whose primary agent's liveness reason is
`writer_released`; or Unknown with that same reason. A Codex session reads Stopped after
a failed or interrupted turn while its process may still be present and able to report,
so Codex Stopped alone never stalls a task, and its later `complete_task` is accepted. A
Stopped state of an unrecognized provider is not an end. Idle, Open, Working, Needs
input, a bare Unknown, and a session with no committed facts leave the task as it is, so
a Codex session whose turn finished and whose state stays Idle does not stall its task.

One ended reading never stalls a task, because a later reading can reverse it. A Claude
Code session reads Closed from one check of its owning process, and the catalog shows
the session live again when the next check finds the process. So the end must be
confirmed:

- The first ended reading only starts a wait of 20 seconds (`END_CONFIRM_DELAY_MS`).
  The wait is longer than the provider's ten-second reconciliation, which checks the
  owning process again.
- The task stalls when a reading at or after the end of the wait is ended too. The
  watcher runs that reading on its own timer, so a quiet catalog still gets it.
- Any reading in between that is not ended drops the first one. The task stays as it
  is, and a later ended reading starts a new wait.
- The wait is in memory only. After a restart of the monitor, the first ended reading
  starts it again.

The decision is written to the task store once. A stalled task keeps its session link
and has no report. The sweep reads memory and the task store only: no provider, Git, or
GitHub read.

**Recovery.** Decided for task T-112 (2026-10-15); it replaces the earlier rule that
Stalled is final. A confirmed end can still be wrong: on T-101 the same session came
back and kept working while the board held the queue on it. A stalled task leaves
Stalled only on evidence from its own started session that it did not end:

- **A report.** The started session's `complete_task` or `block_task` on its stalled task
  is accepted, as an assigned session's is (see [Completion](#completion)). A completion
  sets Needs review and frees the queue the stall held (`releaseQueue`); a block sets
  Blocked by agent, which keeps holding it.
- **A confirmed live reading.** The same sweep reads the session of every stalled task
  with no report (`recoverLiveTasks`). A Working or Needs input reading only starts a
  wait of `END_CONFIRM_DELAY_MS`. The task recovers when a reading at or after the end
  of the wait is open: Working, Needs input, Idle, or Open. An ended, Unknown, or missing
  reading in between drops the first one, and a later live reading starts a new wait.
  An Idle or Open reading never starts the wait, because the catalog can show those for
  a session whose process is gone.
- A recovered task becomes Not queued, keeps its session link, and keeps its column,
  normally In progress. It is linked and in flight again, so the stall rule watches it
  once more, and its card shows the session's observed state. The same transaction
  frees the queue the stall held (`releaseQueue`): a blocked queue names the next stalled
  or blocked task, or runs again when none is left. An `idle` or `paused` queue keeps its
  status.
- The wait is in memory only, like the end's. Recovery never starts, stops, or steers
  the session, and an assigned session's activity never recovers a task: the stall
  watcher follows only the started session.

A linked task whose session has not reported and whose end is not established (a restart
of the computer or of Pomegr, or a cleared session, can leave it so) keeps its state.
Pomegr never marks it Done or Stalled by itself, and the queue never advances past it by
itself, because the task can matter to the whole feature; Mark done and Requeue work on
it (see [Stop on trouble](#queue)).

### A started task is read-only

Decided for GitHub issue #137 (2026-10-11). It replaces the earlier rule that a task
could be changed in any state.

A session works from the task as it was when the session started: the prompt holds the
text and the Complete when list, and the run settings and the images were used once. A
later change would never reach that session, so the board would describe work the agent
was not given. A task has **started** when one of these holds (`rowStarted` in
`server/tasks/task-record.mjs`):

- a session is linked to it;
- a dispatch for it is live, because the prompt is already built;
- its state is Needs review, Blocked by agent, Stalled, or Done.

An assigned session does not start a task: the task stays editable until one of the
three holds (see [Assigned sessions](#assigned-sessions)).

For a started task:

- **`update` answers `conflict`**, whatever field it carries: text, `run`,
  `completeWhen`, or `featureId`. Nothing is written.
- **An image is neither added nor removed.** `image-add` and `image-remove` answer
  `conflict`. `image-read` still answers, so the task window shows the images.
- **Requeue opens it again.** `resolve_requeue` clears the link and the report and sets
  Queued, so the task takes changes until its next session starts. A dispatch that
  expired without a link no longer counts, so that task takes changes too. A done task
  has no requeue and stays as it is.
- **Everything else still works.** `move`, `delete`, `resolve_done`, `resolve_requeue`,
  `record_issue`, and the agent's report are not changes to the task. `queue_group` and
  `queue_ungroup` act on waiting cards, which have not started (see
  [Parallel groups](#parallel-groups)).
- **The task window shows it.** The Task modal draws a task with a session or an outcome
  read-only, with no Save and one fixed line: "This task has started, so it cannot be
  changed.", followed by "Requeue it to change it." when Requeue is offered. The board
  carries no dispatch, so in the minutes between a start and its link the window is
  still editable and Save answers the fixed failure line.

## Columns and card moves

Decided by the product owner on 2026-10-09. It replaces the earlier rule that a card
stays in its column whatever happens to its task.

A board has exactly five columns in v1: Backlog, Ready, In progress, Review, and Done,
in that order (product-owner decision, 2026-10-09; it replaces the columns the user
could add, rename, reorder, delete, and give a role). No action changes a column.
Backlog and Ready hold no role. In progress, Review, and Done always hold one:

| Role | A card moves there when | The write that moves it |
| --- | --- | --- |
| `in_progress` | Its session links | `pomegr:task-feature` IPC | The renderer, through a trusted main frame only | A repository ID and a feature ID. Answers `{ ok: true, description, appVersion }` (each a string or null) or `{ ok: false, error }` with `invalid`, `not_found`, or `unavailable` |
| `POST /internal/tasks/feature-read` | Desktop main, with the desktop token; not reachable through `pomegr:task-action`, and no Next route proxies it | `{ repositoryId, payload: { id } }` in, exactly those keys; `{ ok: true, feature: { description, appVersion } }` out, each field re-bounded (2000 and 40 characters) or null; or one fixed error (`invalid` 400, `not_found` 404, `unavailable` 503). The only desktop path that answers a feature's description and app version |
| `POST /api/agent/v1/tasks/bind` |
| `review` | Its state becomes Needs review | Verification of a `complete_task` report |
| `done` | Its state becomes Done | The user's Mark done (`resolve_done`) |

- **Roles are fixed.** In progress holds `in_progress`, Review holds `review`, and Done
  holds `done`, on every board. The `column_role` action is removed and is refused like
  any unknown action name.
- **The move is part of the state write.** The card's column changes in the same
  transaction that persists the link, the report outcome, or the resolution
  (`server/tasks/task-columns.mjs`, `moveTaskToRole`). The card lands last in the role's
  column, and the column it left closes the gap.
- **A card already in the role's column keeps its place.** The state still changes.
- **Blocked by agent and Stalled move nothing.** The card stays where it is, normally
  the In progress column, and its chip and the Queue banner say that it needs the user.
  These two are the outcomes that hold the queue. A card in Review holds nothing (see
  [Stop on trouble](#queue)).
- **A move by hand does not opt a card out.** The user may drag a card anywhere at any
  time, except a card that waits in the queue (see
  [Queued cards stay in Ready](#queued-cards-stay-in-ready)); it stays there until the
  task's next state change in the table, which moves it again wherever it is. Moving a
  card by hand never changes its state or chip.
- **No move is taken back.** Only the persisted writes in the table, and the queue
  writes below, move a card. No observation does: not a borrowed session state, not a
  start, not a start gate, and not the clock. So Pomegr never moves a card and later
  moves it back because an observation changed.

### Queued cards stay in Ready

Decided for GitHub issue #133 (2026-10-10). It replaces the earlier rule that queuing
and Requeue move nothing, and the private queue position that ordered single tasks.

Ready is the queue's column. A task waits in the queue when its state is Queued or
Scheduled and no session is linked. For every such task:

- **Its card is in Ready.** The write that puts a task in the queue (`queue_add`, with or
  without a time, and `resolve_requeue`) moves the card to the end of Ready in the same
  transaction. A card already in Ready keeps its place. Requeue therefore moves a card:
  from In progress or Review back to Ready, and on to In progress when its new session
  links.
- **It stays there.** `move` answers `conflict` for a waiting card sent to any other
  column, and the board offers no such drop or keyboard move. Removing the task from
  the queue, or its session linking, frees the card; **Remove from queue** leaves the
  card where it is in Ready.
- **Ready reads in start order.** Decided by the product owner on 2026-10-13 (task T-94).
  The waiting cards of Ready are, top to bottom, the order the queue starts them,
  whatever their feature. A feature gives a task context only: it has no place in the
  order, so a change of feature moves no card.
- **A drop lands where it is dropped.** Dragging a card above or below another in Ready
  is how the user reorders the queue. A move never lands a card somewhere else because
  of a feature.
- **Parallel groups stand together.** After every action the store settles Ready
  (`settleReadyColumn(database, repositoryId, groups)` in `server/tasks/task-columns.mjs`,
  called by `apply` after `pruneTaskGroups`): the waiting cards of each parallel group
  take the places they hold together, where the group's first waiting card is. Then
  `settleGroupLanes` in `server/tasks/task-groups.mjs` stands the cards of each group that
  have not started together in one lane: Ready when one of them is there, otherwise the
  lane of the first, at the place of that lane's first member. No other card is
  reordered (see [Parallel groups](#parallel-groups)).
- **The order is the standing one.** A scheduled task that is not due and a dispatched
  task that has not linked keep their place among the waiting cards, although neither is
  in `queue.order` at that moment. The clock therefore never moves a card.

The board mirrors these rules for its optimistic move (`task-board-model.ts`), so a
dragged card is drawn at once where the committed board will show it.

The Board draws the waiting cards of one parallel group in a frame (`readySegments` in
`app/components/tasks/task-ready-groups.ts`). This is a projection of facts the board
already serves, the card order of Ready and each task's `group`. It moves no card, stores
nothing, and adds no field to the board. [Task board design](../design/task-board.md#ready-parallel-groups)
owns how a group looks.

A store written before this rule may hold queued cards in other columns, with single
tasks ordered by a stored `queue_position`. When the monitor opens the store, each
repository is settled once in one transaction: the waiting cards move to the end of
Ready, the single tasks keep the order their stored positions gave (once), and the
stored positions are cleared. The `queue_position` column stays in the schema, unread
after that and never written with a value, so the schema version stays 1.

### Boards made before the fixed columns

A store written before 2026-10-09 may hold other columns: added, renamed, reordered,
or without a role. Such a board is brought to the five columns once
(`server/tasks/task-columns.mjs`):

- **When.** When the monitor opens the store, for every stored repository, so a session
  link or a report that never reads the board already finds the role columns. A board
  read and the start of an action write check again. A board that already holds exactly the five
  columns, in order and with their roles, is not written.
- **One store write.** The whole change is one transaction, and it stands only if the
  board then projects. Otherwise it rolls back and the board reads as it did before.
- **Which column a stored column becomes.** The column of its stored role when it
  holds one; otherwise the column whose fixed name equals its name, ignoring case
  and outer spaces; otherwise Backlog.
- **Kept and merged columns.** The first stored column that matches a fixed column by
  role or name stays as that column, with its ID, and gets the fixed name and place.
  The cards of every other stored column go to the column it becomes, after the cards
  already there, in stored column order and then in their own order. A column with no
  match so empties into Backlog. A board from before column roles has no stored role,
  so its columns match by name only, and a renamed column counts as one with no match. A fixed column that no stored column matches is
  created empty.
- **Never a lost task.** No task row is deleted, and a task's text, state, session
  link, queue place, feature, and update time do not change.
- **Never an unusable store.** A malformed or newer store is not opened for writing,
  so it is not migrated and stays `unavailable`. A board with more than the 12 columns
  an older build allowed, or with a column row outside the stored contract, is not
  repaired either: it stays `unavailable` and unwritten.

### Boards made before parallel groups

A store written before 2026-10-13 may hold feature steps. Such a board is brought to
parallel groups once for each repository (`migrateStepGroups` in
`server/tasks/task-groups.mjs`):

- **When.** When the monitor opens the store, for every stored repository, and at the
  start of every action write. A repository that holds the marker `ready_groups:<repositoryId>`
  with the value `1` in `meta` is not touched again. A repository that the store creates
  after this change is marked at creation, because it never held steps.
- **One store write.** The whole change is one transaction, and it stands only if the
  board then projects. Otherwise it rolls back and the board reads as it did before.
- **Which tasks become a group.** For each step of a feature that holds two or more tasks
  in state Queued or Scheduled, waiting or in flight, those tasks become one group. A
  step with one such task makes no group, and a task in any other state joins none. A
  step with more than 16 such tasks groups its 16 lowest-numbered ones.
- **Every `step` is set to 1.** The column stays in the schema and nothing reads it.
- **Nothing else changes.** No task row is deleted, and a task's column, place in Ready,
  feature, state, schedule, session link, dispatch token, report, queue status, and
  update time stay as they were.
- **What is released.** No step holds a task back any more. A feature that was held by an
  earlier step with a Not queued task is released: its queued cards start at their place
  in Ready. A running queue starts a released card at its next check, as it starts any
  waiting card.
- **Nothing is started, relaunched, or steered.** The migration starts no session,
  relaunches none, and writes to none. A task in flight stays in flight.
- **Never an unusable store.** A malformed or newer store is not opened for writing, so it
  is not migrated and stays `unavailable`.

## Features, parallel groups, and worktrees

Decided by the product owner on 2026-10-13 (task T-94). It replaces feature steps, the
step gate, held features (T-53), and the step move (T-39).

A feature is context. It has a title, a description, and an app version, and it groups
tasks for the owner (see [Feature context](#feature-context)). It has no order: no step,
no priority, no gate, and no held state. The queue starts tasks in Ready order, whatever
their feature. The only way to make tasks run at the same time is a parallel group.
A task waits for another only by its place in Ready, by its group, and by what it runs
after (task T-101, see [Runs after](#runs-after)). T-94 left the dependency out; T-101 adds
it as one more hold on a start, on top of the same order and groups.

### Parallel groups

A parallel group is a set of waiting cards that the owner put together to start at the
same time, each in its own worktree (`server/tasks/task-groups.mjs`).

- **Identity.** A group is an opaque ID, `grp-<12 hex>`, made by the store when the first
  `queue_group` needs a new one. It is derived from no task text, session, or path. It is
  kept per task in `meta` (see [Store](#store)) and served as `Task.group`.
- **Who counts.** A membership counts for a task in the queue, state Queued or
  Scheduled, waiting or in flight, and for a planned task: state Not queued, no linked
  session, and its card in Backlog or Ready (`groupMemberCounts` in
  `server/tasks/task-record.mjs`). A task in Needs review, Stalled, Blocked by agent, or
  Done, a Not queued task started by hand, and a planned card moved to a column with a
  role are no member. A group left with one member that counts is no group.
  `pruneTaskGroups` clears the memberships that no longer count, after every action and
  before a move reads them, and the board projection serves `group` only for a group of
  two or more.
- **Only the queue's members start together.** `orderQueue` counts only the members in the
  queue: a planned member is no candidate and holds nothing, and a member alone in the
  queue starts on its own, in the repository root. A planned member that is queued later,
  while the members in the queue run, starts with them, in its own worktree.
- **Joining.** `queue_group` puts 2 to 16 cards that have not started into one group (see
  [Boundaries](#boundaries)): waiting cards and planned cards alike. The joining cards take
  the group of the first listed card that is in one, or a new group, and land right after
  the last card of that group in its column: Ready when any member is in the queue,
  otherwise the first listed card's column. The started members of a group whose
  waiting cards all join go with them. A group holds at most 16 members.
- **Leaving.** `queue_ungroup` takes cards out of their group. A card that stood between
  two cards that stay in the group lands right after the group, because the group's cards
  stand together; any other card keeps its place.
  `move` with `group: "leave"` takes one card out and lands it. Without `group`, a
  grouped waiting card that lands away from every other waiting card of its group leaves
  the group, and one that lands beside a sibling stays in it. `queue_remove`, `delete`,
  and `resolve_requeue` take the task out of its group. A group is not a lasting
  structure: it ends when its members leave the queue.
- **Moving a group.** `move` with `group: "block"` moves the cards of the card's group
  that have not started together to `position` in any column, counted after the group
  leaves, in board order. A block with a waiting card sent out of Ready answers `conflict`.
- **Release rule.** A group releases the next Ready work when every member is in Review
  or Done, or has left the queue. Until then the queue starts only waiting members of the
  group (see **Next start** under [Queue](#queue)).
- **A held member.** A member that a start gate holds keeps its place and starts when the
  gate opens. Its siblings start without it, and the work after the group waits for it. A
  scheduled member that is not yet due is not a candidate and holds nothing.
- **A started member.** A member that already started cannot be taken out of its group
  with `queue_ungroup`, which answers `conflict`: its session runs in the group's turn
  until it reports. It leaves the group when it reaches Needs review, Stalled, Blocked
  by agent, or Done, or when it is requeued.
- **Not a dependency.** A group says "start these together". It orders no task after
  another and gates nothing on a task's result; [Runs after](#runs-after) does that.

### Planning before Ready

Task T-101, approved by the product owner on 2026-10-14. The owner arranges cards in
Backlog the way Ready reads, before any card is queued.

- **One after another is card order.** The order of the cards in Backlog is the plan, as
  the order of Ready is the start order. No second order is stored.
- **Together is a group.** A group of planned cards is the same group as in Ready: the
  same ID, limit, frame, and actions. Cards that only sit next to each other make no group.
- **The plan moves whole.** Dragging a group's frame moves its cards that have not started
  as one block. `queue_add` with `{ id, group: "block" }` (**Queue group**) queues every
  card of the task's group that is not queued yet, and puts the group's cards at the end of
  Ready in the order they had (`queueGroupCards` in `server/tasks/task-card-moves.mjs`).
- **Queueing one member brings the plan.** `queue_add` of one planned member queues that
  member only. Its card goes to Ready, and the group's other cards follow it there, still
  Not queued, because a group stands together in one lane.
- **A card queued by itself lands last in Ready**, as before. The order of cards queued one
  at a time is the order they were queued.
- **Editable until a member starts.** The owner changes or clears a plan with the same
  actions as in Ready. A member that started cannot be taken out (`conflict`).
- **Nothing to migrate.** A board from before T-101 holds no planned membership, because
  `pruneTaskGroups` removed every membership outside the queue. Its groups, tasks, columns,
  places, sessions, reports, and queue membership stay as they are.

## Runs after

Task T-101, approved by the product owner on 2026-10-14. The owner says that a task runs
after other tasks of the same board: it never starts until each of them is Done or deleted.

- **A hold, not an order.** A task that runs after an unfinished task is not in
  `queue.order` and is no candidate for a start, like a scheduled task before its time. It
  keeps its card place and holds nothing behind it: the queue starts the cards after it.
  Once every task it runs after is Done or deleted, it starts at its place by the
  [Queue](#queue) rule. The one ordering rule stays `orderQueue`.
- **Done or deleted frees it.** Review is not enough: only the owner's Mark done frees a
  task. A deleted task is taken out of every list in the write that deletes it.
- **Every start.** The queue never starts the task, and `start-plan` answers `gate_held`
  for a manual start (`startGates` in `server/tasks/task-queue-advance.mjs`). It is judged
  before the start gates and is no start gate.
- **Explained like the other holds.** `queue.waits` carries `runs_after` with the
  unfinished tasks (see [Why a task waits](#why-a-task-waits)).
- **Any two tasks of a board.** In any column, with or without a feature, in the same
  group or not. A task runs after at most 8 tasks.
- **Set by `after_set`.** `{ id, after }` replaces the list; an empty list clears it (see
  [Boundaries](#boundaries)). A task that has started takes no list (`conflict`), because
  its session started from the task as it was.
- **Also set by an agent** (task T-111, 2026-10-15). `add_task` and `update_task` take an
  optional `runs_after`, which the routes send to the store as `after`. The store runs
  `setTaskAfter` inside the agent action's own transaction, so the bounds and the loop
  refusal are the ones of `after_set`, and a refused list writes nothing of the call. A
  task of the list that is not on the board answers `after_not_found`, and a loop answers
  `after_loop`. On `add_task` an empty list is no list; on `update_task` it clears the
  list. See [Agent task update](#agent-task-update).
- **A loop is refused.** A list that would make tasks wait for each other, directly or
  through other tasks, answers `conflict` and writes nothing. The Task modal says one fixed
  line: “These tasks would wait for each other, so nothing was changed.”
- **A group member that waits** holds nothing for its group, like a scheduled member that
  is not due. Its siblings start without it, and it starts in its group's turn when it is
  free.
- **Running sessions are not touched.** A list changes no session, starts nothing, and
  stops nothing.

### Worktrees

Worktree creation and cleanup belong to the desktop (`task-worktree.mjs`); worktree
paths stay desktop-private and never reach the monitor store or browser state.

- **Which tasks get a worktree.** A task that is an effective member of a parallel group
  at the time it starts, which means its stored group holds two or more tasks that are in
  the queue (`taskRunsInGroup` in `task-groups.mjs`). A task that is in no group, or whose
  group has dropped to one member, runs in the repository root, whatever its feature,
  unless the owner asked for a separate worktree for that one manual start (see
  [Separate worktree](#separate-worktree-for-a-dirty-repository)). The monitor decides
  this when it answers the start plan (`worktree`, a boolean); it never learns where the
  worktree is.
- **Where.** `<repository root>/.pomegr/worktrees/<task ID>`, inside the repository (task
  T-27, product-owner decision of 2026-10-11). The root is the one the monitor answers in
  the start plan and the task ID is a validated identifier, so no task text shapes the
  directory. Before the first worktree is added, the desktop writes
  `.pomegr/worktrees/.gitignore` with the one line `*` when the file is not there. The
  folder then ignores everything in it, itself included, so the repository's own working
  tree stays clean for the [working-tree gate](#start-gates) and the Tree clean condition,
  and nothing the repository tracks is changed. When that file cannot be written, the
  start fails and no worktree is made.
- **Worktrees made before the move.** Until T-27 a worktree was made at
  `<desktop data root>/task-worktrees/<repository ID>/<task ID>`. One that is still there
  is the task's worktree: a requeue reuses it, Open folder opens it, and a removal removes
  it, each where it is. Nothing is moved, and a new worktree is never made there.
- **Branch.** `tasks/<task ID>`, created at the repository's current commit, or checked out
  when it already exists. Uncommitted changes of the repository root are not part of it.
  Each member of a group has its own worktree and its own branch.
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
  from inside it, lists it on `tasks/<task ID>`. Desktop main asks the monitor for the
  repository root (`POST /internal/tasks/worktree-root`); without an answer only a
  worktree made before the move is found. The path is resolved and opened in desktop
  main and never reaches the renderer, the task store, a log, or a report.
  Pomegr removes nothing here and never removes a worktree that has uncommitted changes.
- **Removal.** The desktop removes a worktree only when Git lists it as a worktree of the
  repository, its working tree is clean, and its HEAD holds no commit that exists nowhere
  else (no remote and no other local branch). The removal is Git's own unforced
  `worktree remove`. There are two automatic removals: of a worktree made for a start
  that then failed, and of the worktree of a task marked done (below).
- **Branch.** A removal that is asked to remove the branch deletes `tasks/<task ID>` only
  after the worktree is gone and only when the worktree was on that branch, so the check
  above has just found every commit of the branch on a remote or on another local branch.
  It is therefore `git branch -D`: Git's own merged check compares with the root's
  current branch, and would keep a branch whose pull request was merged as a squash. A
  worktree on another branch, or on none, goes without a branch delete.
- **When a task is done.** Mark done (`resolve_done`) on a task that does not keep its
  worktree (`run.keepWorktree`) stores that the task waits for the removal. The desktop
  queue runner asks `POST /internal/tasks/worktree-cleanups` on its first tick and on
  every fourth after it (about once a minute), and gets at most 64
  `{ repositoryId, taskId, repositoryRoot }` entries; a repository whose root the monitor
  has not located in this run is left out. For each it runs the removal above with the
  branch delete. When the worktree is removed, or there is none (the task ran in the
  repository root), it posts `POST /internal/tasks/worktree-cleaned` with `{ id }` and the
  task is not listed again. A worktree it could not remove stays listed and is tried on
  a later pass: one with uncommitted changes or a commit that exists nowhere else is
  kept until the user commits, pushes, or removes it, and one whose folder is still in
  use (a terminal open in it) goes once it is free. Pomegr never forces either. A task
  that was done before T-27 is never listed.
- **Git.** `execFile` with argument arrays and no shell, with a 30-second limit per call.

### Done features

Task T-130, product-owner decision of 2026-10-14. It replaces the derived rule, under
which a feature was done when it had tasks and every one of them was done.

- **One rule.** A feature is done when the owner marked it done, and only then. The
  states of its tasks play no part: a feature whose tasks are all done stays open until
  the owner marks it, and a feature with no task can be done. The flag is stored, not
  derived, and an older store reads every feature as not done (no backfill).
- **Done with open tasks.** The owner may mark a feature done while it still holds tasks
  that are not done. Those cards stay where they are and keep the feature as context:
  nothing moves, unqueues, changes state, leaves a group, or is deleted. A queued task of
  a done feature still starts.
- **What done refuses.** A done feature takes no new task. `create`, the store's
  `agent_create`, and an `update` or `agent_update` that moves a task into it answer
  `conflict`. The agent's `add_task` route matches only a feature that is not done, so
  it answers `feature_not_found` first, as before. A task already in the feature keeps it.
- **Reopen.** The owner reopens a done feature through the same control, and it takes
  tasks again.
- **Desktop only.** Only the desktop `feature_update` takes `done`. The agent's
  `update_feature` (`agent_feature_update`), the paired-device route, and every other
  agent tool never mark a feature done or reopen one. Marking done changes no name,
  description, or app version, and editing those keeps the flag.
- **Served.** The board serves the flag as `features[].done`, so the board, the task
  forms' Feature field, Tasks home's open-feature count, and Aril's board snapshot read
  the same value.

### Feature context

Task T-33, product-owner decision of 2026-10-10. A feature is a record with three
fields: a **title** (the stored `name`, one line of 1 to 80 characters, unique in its
repository), a **description** (plain text of at most 2000 characters, or none), and an
**app version** (one line of at most 40 characters, or none). The description holds the
context every task of the feature shares, so a task's own text stays short. The app
version is the version the feature is planned for. It is free text: Pomegr never parses
or compares it, and it gates nothing.

- **The prompt carries the title and the ID only.** The session prompt of a task that
  belongs to a feature holds one fixed line with the feature's title and its ID
  (`feat-<12 hex>`), and the instruction to call `get_feature` for the rest (see
  [Starting a session](#starting-a-session)). The description and the app version never
  enter a prompt.
- **`get_feature` reads the rest.** It answers `{ id, title, description, appVersion }`
  for one feature of the calling session's board. The feature is named by its ID or its
  exact title; with no input it is the feature of the task the session is linked to.
  A stored description or app version that does not validate reads as not set.
- **`create_feature`** makes a feature from a title and, optionally, a description and
  an app version. A title that exists answers `conflict`, and a 51st feature `limit`.
  It attaches no task; `add_task` attaches one by the feature's title. This replaces
  the earlier rule that agents never create features.
- **`update_feature`** changes any of the three fields of one feature. A field that is
  present replaces the stored one whole, an absent field is left as stored, and a null
  description or app version clears it (the tool sends null for an empty string). A
  new title that another feature holds answers `conflict`. It changes no task, group,
  state, or update time.
- **`delete_feature`** deletes only a feature that has no task; otherwise it answers
  `conflict`. Its description and app version go in the same write.
- **Which features.** Any feature of the session's own board, whoever made it. The
  board is the one `add_task` writes to for that session (see
  [Session binding](#session-binding)). No input names a repository, a path, or a
  session.
- **Store only.** The store actions `agent_feature_create`, `agent_feature_update`, and
  `agent_feature_delete` are absent from the fixed action list, like `agent_create`, so
  the desktop route, the paired-device route, and the IPC channel never accept them.
  The desktop `feature_delete` is a different action, with its own rule (below).
- **Desktop create and update.** The desktop `feature_create` takes `{ name }` and,
  optionally, `description` and `appVersion`. The desktop `feature_update` takes
  `{ id, name?, description?, appVersion?, done? }` with at least one field beside `id`;
  `done` is a boolean that only it takes (see [Done features](#done-features)).
  They validate and store the fields as the agent tools do, in the same store rows.
- **Desktop delete.** The desktop `feature_delete` takes `{ id }` and nothing else. It
  detaches every task of the feature, then deletes the feature with its description and
  app version, all in the one write of the action. A detached task keeps its column,
  state, place in Ready, parallel group, schedule, session, report, and update time, and
  loses its feature only. The feature has no part in the order, so the queue order does
  not change. It is refused
  with `conflict`, and writes nothing, while a task of the feature has started and is not
  done: `rowStarted` of `task-record.mjs`, the rule that refuses `update`, with a `done`
  task never blocking. A queue pause that names a detached task stays. An
  unknown feature, or one of another repository, is `not_found`. `delete_feature` keeps
  its own rule: only a feature that has no task.
- **Desktop read.** The desktop reads one feature's description and app version through
  its own IPC channel, `pomegr:task-feature`, and the route `feature-read`. The desktop
  app is the only client that can read or change them besides the agent tools.
  A paired device and a browser can neither read nor update them.

The monitor serves the four tools as `POST /api/agent/v1/tasks/feature-get`,
`feature-create`, `feature-update`, and `feature-delete`, under the gate of `add` and
with the same content-type check. Each body is a JSON object of at most 16 KiB with
`sessionRef` and only these keys:

| Path | Keys beside `sessionRef` | Answer on success |
| --- | --- | --- |
| `feature-get` | `feature`, optional | `{ feature: { id, title, description, appVersion } }` |
| `feature-create` | `title`, and optionally `description` and `appVersion` | `{ featureId }` |
| `feature-update` | `feature`, and at least one of `title`, `description`, and `appVersion` | `{ featureId }` |
| `feature-delete` | `feature` | nothing more |

Every answer is `{ schemaVersion: 1, ok: true, ... }` or `{ schemaVersion: 1, ok: false,
reason }`. Reasons: `invalid` (400), `session_not_found` (404), `repository_unavailable`
(409), `not_found` (404), `conflict` (409), `limit` (409), and `unavailable` (503). Only
`feature-get` answers feature content; the three writes answer an ID or nothing. The
tools are in the plugins from version 0.9.4.

In Claude Code the hook binds and signs each of the four as its own tool name, like the
task writes. It also approves `get_feature` itself (`permissionDecision: "allow"`), as it
does for the read of the session's own context: the call reads the session's own board
and changes nothing, and a session the queue started must not wait at a prompt to read
its task's context. The three writes get no permission decision from the hook, so Claude
Code asks or decides as for any MCP write.

## Queue

The queue is the ordered set of queued and scheduled tasks, ordered by the pure `orderQueue` rule. It
is advanced only by the desktop queue runner, only after the user turned the queue on.
Ready order decides: the queue starts the top waiting card of Ready, with the rest of
its parallel group. Every start first passes the [start gates](#start-gates).

- **Order.** `queue.order` on the board lists the IDs of the tasks that wait to start now:
  those in state `queued`, and those in state `scheduled` whose own time has come. They
  are in the order of their cards in the Ready column, top first (`Task.position`; a tie
  orders by task number as a number, T-2 before T-10), one ID per task. It is the order
  the cards read in Ready (see [Queued cards stay in Ready](#queued-cards-stay-in-ready)),
  so the Board and the Queue view always show one order. A task's feature has no part in it. A task that
  runs after an unfinished task is not in it (see [Runs after](#runs-after)). `orderQueue(tasks)`
  returns `{ order, groups }`: `order` is that list, and `groups` maps each task ID to its
  effective parallel group or null. A task in another state is not in the order, even
  when it belongs to a queued task's group. A task that
  already started is not in the order either: one with a linked session and no report, or
  a dispatch still inside its ten minutes (`rowInFlight` in `task-record.mjs`, which judges
  the dispatch with `dispatchStanding` from the leaf module `task-dispatch-standing.mjs`;
  the board projection and the queue share this one rule). It keeps its state and
  its group, and a waiting task outside its group waits on it (`blockedBy` of
  `queue.gates.next`, reason `earlier_task`). `queue.gates.next`
  never names it. The Board shows it with the borrowed session state, or its own chip
  until a session links, with no Waiting line, no next marker, and no move. The task
  shown as next is the one the queue would start first (`queue.gates.next`): a waiting
  member of the group that runs, before the first entry of the order.
- **Place in the queue.** A task's place is its card's place in Ready
  (`Task.position`, already on the board). A task queued from another column joins last,
  because its card lands last in Ready; one queued from Ready runs where its card is.
  Removing a task from the queue leaves its card in Ready, so queuing it again gives it
  the same place unless the card was moved.

- **On and off.** The stored status is per repository and starts as `idle`, which is the
  queue turned off. `queue_settings` with `{ on: true }` sets it to `running`, or to
  `blocked` with the lowest-numbered task that is stalled or blocked in
  `blockedBy` when one exists; `{ on: false }` sets it back to `idle`. Turning the queue
  off never touches a running session. The agent chat sends this same action, with
  `{ on }` alone, for a queue proposal the owner applied
  (see [Agent chat: Queue change](agent-chat.md#queue-change)). No other action turns the queue on, and the one
  other write that turns it off is the end of a pause whose named task is gone (see
  **A pause ends with its task** below).
- **Next start.** The pure `nextQueueStart` rule in `task-queue.mjs` answers for one
  repository. Nothing starts unless the status is `running`. The queue never passes the
  first waiting card of Ready. A task is in flight when it
  has a linked session and no outcome, or a dispatch that is still live. With nothing in
  flight, the starts are the first entry of `queue.order` and the other waiting due
  tasks of its parallel group, if it has one, so the task shown as next is always among
  them. While tasks are in flight, only the waiting due tasks of their own group may
  start; tasks in flight outside one group hold every start, and so does any task in
  flight that is in no group. A group releases the next Ready work when every member is
  in Review or Done (or has left the queue). A task in review is finished work that waits
  for the owner, so the work after it can start. A member that a start gate holds keeps
  its place and starts when the gate opens, and its siblings start without it. A
  scheduled member that is not due is not a candidate and holds nothing. The pure
  `earlierTaskBlocker(taskId, tasks)` names the lowest-numbered task in flight that is
  not in the task's own group, or null; it is what `queue.gates.next` reports as
  `blockedBy`.
- **Gates.** Each start is judged on its own. One that a start gate holds is
  not answered as a next start and changes nothing: the queue stays `running`, the task
  stays `queued`, and the next poll judges the gates again while the rest of its group
  starts. A held gate is a wait, not one of the outcomes that block or pause the queue.
- **Runner.** The desktop main process polls `POST /internal/tasks/queue-next` (desktop
  token, body `{}`) every 15 seconds on one unreferenced timer. The answer holds at most
  16 `{ repositoryId, taskId }` pairs, the tasks of each repository whose queue has a
  next start (the first waiting task and the rest of its group), and no task content. The runner starts them
  one after another in the same tick through the same dispatcher a manual start uses,
  without the native confirmation, because the user turned the queue on. When one start
  pauses a queue, the rest of that repository's answer is not started. A manual start and a queued start never overlap. The next start
  is served only on this route, never on `GET /api/tasks`. The same timer also removes the
  worktrees of done tasks (see [Worktrees](#worktrees)).
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
  - **A pause ends with its task.** A pause is about the one task in `blockedBy`. When
    that task is deleted (`delete`, or the agent's `remove_task`), removed from the queue
    (`queue_remove`), marked done (`resolve_done`), or requeued (`resolve_requeue`), the
    same transaction clears the status, `blockedBy`, and the reason together
    (`releasePause` in `task-queue-advance.mjs`), so no banner names a task that is gone
    or no longer the one that failed to start. The same action on any other task leaves
    the pause as it is.
  - **What the status becomes.** It depends on whose the cause was. `worktree_dirty` and
    `session_not_linked` are the task's own (its worktree, its start), so the cause went
    with the task: the queue is set as if the user turned it on again, `running`, or
    `blocked` at the lowest-numbered stalled or blocked task, and the repository's
    expired unlinked dispatches are cleared. With nothing queued, a running queue starts
    nothing. `cli_missing`, `plugin_missing`, `unsupported_platform`, `start_failed`, and
    a pause with no stored reason are about the computer or the repository, so the cause
    is still there: the queue is set to `idle`, turned off. Running it again would start
    the next task into the same failure without the user asking for the retry, and
    would show On and then a new pause.
  - A store written before this rule may hold a pause at a task that was deleted. The
    board never serves that ID (see [Record](#record)), and when the monitor
    opens the store, each such pause ends by the same rule (`releaseDanglingPause`).
- **Stop on trouble.** A stalled task or an agent block
  sets the queue to `blocked` with the responsible task in `blockedBy`. Nothing new
  starts until the user resolves it, by **Mark done and resume** (`resolve_done`) or
  **Requeue** (`resolve_requeue`). Sessions already running continue.
  - **A stalled task can recover.** When its started session reports complete, or is
    confirmed live again (see [States](#states)), the task leaves Stalled and the queue
    the stall held is freed by the same `releaseQueue` rule a resolution uses. A block
    from that session keeps holding the queue, now as Blocked by agent.
  - **Review does not stop the queue.** Decided for GitHub issue #135 (2026-10-10); it
    replaces the earlier rule that a failed check blocks the queue. A task that needs
    review is finished work: its card waits in the Review column, the queue stays
    `running`, and it goes on to the next waiting card once every member of the task's
    group is in Review or Done. The owner resolves it with the same two actions, at any time. When the work that
    follows must not start, the agent's path is `block_task`, whose card stays in In
    progress and holds the queue.
  - A store written before this rule may hold a queue that is `blocked` at a task that
    needs review. When the monitor opens the store, each such queue names the
    lowest-numbered stalled or blocked task instead, or runs again when there is none
    (`releaseQueue`, the rule a resolution uses).
  - A block or a stall changes the stored status only of a queue that is `running`: it becomes
    `blocked`, and a queue that is already blocked keeps its first blocker. An `idle` or
    `paused` queue keeps its status; turning the queue on then computes `blocked` when any
    task is blocked or stalled.
  - `resolve_done` sets such a task to Done and keeps its report and session link.
    `resolve_requeue` puts it back in the queue as Queued, its card last in Ready, and clears its
    report, session link, and any dispatch, so a new session can be started for it and
    report once more. Either one, on a blocked queue, names the lowest-numbered task
    that still holds it in `blockedBy`, or sets the queue back to `running` when
    none is left. Both also accept a task that needs review, and both answer `conflict`
    for a task in any other state.
  - **A linked task with no report.** Mark done and Requeue also accept a linked task
    whose session has not reported (a session link, state Not queued, Queued, or
    Scheduled, and no report). Pomegr never marks such a task Done or Stalled by itself,
    and the queue never advances past it by itself, because the task can matter to the
    whole feature; the user decides in the Pomegr UI, where the task modal offers **Mark
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
    the task to `scheduled`. A scheduled task is a queued task with a start time: its card
    keeps its place in Ready, it is in `queue.order` only from its time on, and is started by the
    queue like any other task, so it needs the queue on. Until then it is not startable by
    hand either (`start-plan` answers `gate_held`). A scheduled task that is not due holds
    nothing behind it: the tasks after it start. It is not a candidate until its time
    comes, and a scheduled member of a group that is not due holds nothing for its group.
    The task keeps the state `scheduled` and
    its time after it started; the card then borrows the session's state.
  - **The queue's window.** `queue_settings` with `{ schedule: { startAt, stopAfter } }`
    stores the two times in the `meta` table under `queue_start_at:<repositoryId>` and
    `queue_stop_after:<repositoryId>`, so the schema version stays 1. A running queue
    answers no start before `startAt` and none from `stopAfter` on. The queue stays
    `running` and its tasks stay queued; the board names the hold on the next task as
    `before_queue_start` or `after_queue_stop`. The window holds the queue's starts only:
    a start the user makes by hand, with its confirmation, is not held by it.
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

### Why a task waits

Task T-73, 2026-10-13, brought to Ready order and parallel groups by task T-94 the same
day. The owner could not tell from a card why a queued task had not started. Every
board that leaves the monitor carries `queue.waits`, one
entry for each task that waits: a task whose state is Queued or Scheduled and that has
not started (no linked session and no live dispatch).

- **One rule, no second order.** The pure `explainQueueWaits` in
  `server/tasks/task-queue-waits.mjs` reads the order and the groups from `orderQueue`
  and the next start from `nextQueueStart`.
  It orders nothing itself. `fillQueueWaits` in `task-queue-advance.mjs` hands it the
  stored rows as the queue runner reads them (`queueRecord`), so a live dispatch counts
  as started here as it does for a start.
- **Place.** `place` is the task's place in `queue.order`, from 1. It is null for a task
  that is not in the order: a scheduled task before its own time, and a task that runs
  after an unfinished task.
- **Reasons.** `reasons` lists every reason that holds, in the order of the table. Each
  is `{ reason, taskIds, more }`: `taskIds` names at most eight tasks, in start order,
  and `more` counts the ones left out. A reason that names no task has an empty list.

| Reason | Holds when | Names |
| --- | --- | --- |
| `queue_off` | The queue's status is `idle` | Nothing |
| `queue_blocked` | The queue's status is `blocked` | The task in `blockedBy`, when the board holds it |
| `queue_paused` | The queue's status is `paused` | The task in `blockedBy`, when the board holds it |
| `own_schedule` | The task is scheduled and its own time has not come | Nothing |
| `runs_after` | The task runs after tasks that are on the board and not Done | Those tasks |
| `earlier_tasks` | Tasks outside its own parallel group are before it in the order: the cards above it in Ready | Those tasks |
| `running_work` | Tasks in flight outside its own parallel group hold the queue | Those tasks |
| A [start gate](#start-gates) reason, `before_queue_start`, or `after_queue_stop` | The queue runs, the task is one `nextQueueStart` would start now, and `startGates` or `queueWindowHold` holds it | Nothing |
| `unknown` | The committed facts name none of the reasons above | Nothing |

- **Off is not a blocker.** `queue_off` says only that the owner has not turned the
  queue on. `queue_blocked` and `queue_paused` are confirmed: a task stalled, was blocked
  by its agent, or failed to start. A queue that is not running still lists the work
  that starts before the task, so the owner sees the order before turning it on.
- **Gates are judged for a start only.** A start gate holds a start, so only a task the
  running queue would start now carries a gate reason. A task behind other work carries
  that work, and a queue that is off, blocked, or paused carries no gate reason.
- **The tasks of its own parallel group are not ahead of a task.** They start with it,
  and a member that already runs does not hold it. A waiting member of the group that
  runs is a task the queue would start now, so it carries only the gate that holds it.
- **A feature is no reason.** A feature gives no order, so no reason names one.
- **Unknown is never a pass.** A gate with no fact is `usage_unknown`,
  `provider_status_unknown`, or `tree_unknown`, as for a start. A runtime without the gate
  lookup reads all three, because it holds every start. A waiting task with no reason at
  all has an empty list: the monitor knows no hold, and the page says exactly that. The
  rule answers `unknown` when a task is neither startable nor behind anything it can
  name, such as a task whose expired start is about to pause the queue.
- **A reading, never a state.** The waits are computed on each read from the store and
  the committed gate facts, like `queue.gates`. Nothing is stored, no card moves, no
  priority changes, and nothing starts. One board asks for its gate facts once, so the
  gates and the waits judge the same reading.
- **Serving.** `GET /api/tasks` rebuilds the list field by field (`projectWaits` in
  `server/serving/task-routes.mjs`) and drops it whole when one value is outside the
  contract. The client validates it the same way (`parseWaits` in `app/tasks-store.ts`)
  and words it in `app/components/tasks/task-wait-model.ts`, which orders nothing.
- **Shown.** A waiting card of Ready adds its place and a Waiting line, and the Task
  modal of a waiting task starts with a Queue block.
  [Task board design](../design/task-board.md#ready-parallel-groups) and
  [Task modal design](../design/task-modal.md#body) own how they look.

## Tasks home

Task T-54, validated by the product owner on 2026-10-11. The Tasks home is the page a
client sees before it chooses a repository: what waits for the owner on any board, and
one row for each board. [Task board design](../design/task-board.md#tasks-home) owns how
it looks.

- **One read.** `GET /api/tasks?view=home` answers every stored board at once, so the
  page does not read each board. `view=home` is the whole query: any other key beside it
  is `400`, and a `view` with any other value is an invalid board query.
- **Shape.** `TaskHome` in `shared/task-contract.ts`:
  `{ version: 1, readiness, boards, attention, attentionTotal }`.
  - A board is `{ repositoryId, readiness, counts, openFeatures, queue, updatedAt }`.
    `counts` holds the five column counts in board order. `openFeatures` counts the
    features that are not done. `queue` is `{ status, blockedBy, pauseReason }`.
    `updatedAt` is the newest `updatedAt` of the board's tasks, or null.
  - A board that does not project is `readiness: "unavailable"` with no counts. It is
    never served as an empty ready board.
  - An attention item is `{ repositoryId, taskId, title, state }` for a task whose state
    is `needs_review`, `stalled`, or `blocked`. The newest change is first. At most 50
    are served, and `attentionTotal` counts them all.
- **Only stored boards.** `readHome` in `server/tasks/task-store.mjs` reads the
  repositories the store already holds, at most 200. It seeds no board and writes
  nothing, so a repository that never had a task is not in the answer. The page draws
  such a repository from the repository inventory, as an empty board with the queue off.
- **Pure summary.** `summarizeTaskHome(entries)` in `server/tasks/task-home.mjs` takes
  projected boards and returns plain values, like the other rule modules.
- **Committed facts only.** The read is a committed-store read like the board's. A
  session title comes from the same memory lookup. It reads no gate fact, no check
  fact, and no run-model catalog.
- **Serving.** `server/serving/task-home-route.mjs` gates the read like the board read,
  and serves only the contract keys of what the store answered, each inside its bound.
- **Client.** `app/tasks-home-store.ts` polls the read every ten seconds while the page
  is visible, and keeps the last home until a complete answer replaces it.
- **Queue paused.** A paused queue is not an attention item: its row in Boards says
  **Paused**, and the board's banner names the task and the reason.

## Start gates

Before every start, manual or queued, the pure `evaluateGates(task, facts, settings)` in
`task-gates.mjs` judges committed facts and returns the fixed reasons a start cannot
proceed. A task that runs after an unfinished task is held before the gates, by every
start (see [Runs after](#runs-after)). A start needs all of the following.

1. No earlier task is in flight outside the task's own parallel group (`earlier_task`
   otherwise). The board names the lowest-numbered task in flight that is not in the
   task's group (`earlierTaskBlocker`). The queue's own rule already starts nothing while
   such a task runs, so this gate lets the Board say why the next task waits. It holds
   only the queue's starts. As decided by the product owner on 2026-10-10, a manual start
   is an override of queue order: `start-plan` does not judge this gate, and the other
   three still hold the start.
2. The task's provider has usage capacity: its five-hour window, as a whole percentage,
   is below the threshold (`usage_over` otherwise). The threshold is 70, 85, or 95
   percent per repository, 85 by default, set with `queue_settings` `{ threshold }` and
   kept in the store's `meta` table under `queue_gate_threshold:<repositoryId>`. The
   seven-day window is normally informational. Codex accounts that report only seven-day windows use their highest weekly percentage instead.
   A missing, expired, or malformed five-hour reading never permits this substitution. A task with no provider is
   judged as Claude Code, the provider it starts on.
3. The task's provider has no incident in the committed public provider status
   (`provider_incident`): any status but operational is an incident. Public status does
   not prove impact or causation, so it gates a start but is not shown as a cause.
4. The working tree of the repository root is clean (`tree_dirty`), by the same Git
   status rule the complete-when check uses. The gate reads the root for every task, a task
   that starts in its own worktree included: a new worktree starts at the root's current
   commit, so uncommitted changes of the root would not be part of it. A worktree that
   is used again must be clean too; the desktop checks that itself and fails the start
   otherwise.

### Separate worktree for a dirty repository

Task T-46, 2026-10-10. Gate 4 holds a start in the root because the session would work on
top of the owner's uncommitted changes, and it holds a parallel task because its new
worktree would not hold them. When that gate is the only one that holds a manual start,
the owner may accept the second case on purpose:

- `start-plan` answers the fixed `tree_dirty` instead of `gate_held` when the start is
  held by `tree_dirty` and by nothing else. Any other hold beside it, an unknown tree, and
  a scheduled task before its own time stay `gate_held`. The working-tree reading is
  already on `queue.gates.workingTree`, so the answer exposes no new fact.
- After that answer the task modal shows **Start in separate worktree**. It calls
  `pomegr:task-start` again with the fixed third argument `true`, or the paired start
  route with `worktree: true`. The confirmation on the requesting device names the separate worktree.
  It says that uncommitted changes are not part of it and stay untouched. Cancelling it leaves
  the offer in place.
- Desktop main then asks for the plan with `{ id, worktree: true }`. For that payload the
  monitor does not hold the start on `tree_dirty` (every other gate still holds it) and
  answers `worktree: true` in the plan, whatever the task's group. A `worktree` value
  other than `true` is `invalid`. Desktop main refuses a plan without `worktree: true`
  for such a start and aborts the dispatch, so a start confirmed for a separate worktree
  never runs in the root.
- The worktree is the task's ordinary one: the same directory, the `tasks/<task ID>`
  branch at the root's current commit, and the same reuse and removal rules, so a
  worktree left from an earlier start that has uncommitted changes answers
  `worktree_dirty`. The root and its changes are never touched, stashed, or copied.
- The choice is for that one start and is stored nowhere. The queue never makes it: a
  queued start a dirty root holds keeps waiting, and the queue runner treats `tree_dirty`
  like `gate_held`.

A fact that is missing, stale, or partial is unknown (`usage_unknown`,
`provider_status_unknown`, `tree_unknown`). Unknown holds a start exactly like a failed
gate and never counts as passed. The other provider's usage and status never hold a
task.

The gates read already committed facts, supplied by `resolveTaskGateFacts(repositoryId)`
in `server/runtime/task-gate-facts.mjs`:

| Fact | Source | Counts when |
| --- | --- | --- |
| Usage | The committed usage response in memory | The provider's usage is available, its last successful reading is no older than ten minutes, and no refresh has failed since that reading. The reading is the highest window of that length. See [Usage reading](#usage-reading) |
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

The tree check uses only bounded local `git status`, without a HEAD, branch, remote, or file projection dependency.
A successful empty status proves clean; any status entry proves dirty, including entries omitted from public file lists.
The observation belongs to the recognized root. A changed or missing root invalidates its previous reading.

### Usage reading

Task T-49, 2026-10-11. `gateUsageFact` judges a provider's committed usage by three
rules, and by nothing else:

1. **Age.** The last successful reading (`fetchedAt`) is no older than ten minutes
   (`TASK_GATE_USAGE_MAX_AGE_MS`), and is not in the future.
2. **No failure since.** No refresh failed after that reading: a row with a
   `failureKind` is unknown when its `attemptedAt` is later than its `fetchedAt`, or is
   missing. The retained last good percentages stay on Usage limits, but they do not
   pass the gate. A reading taken after the failed attempt counts again.
3. **Current window.** A window whose `resetsAt` has passed is unknown: its percentage
   describes a period that ended. A window with no reset time is judged by rules 1 and 2.

For Codex, a nonempty reading containing only seven-day windows establishes a weekly-only account.
The private `weeklyOnly` fact selects its weekly percentage for the same threshold.
The board keeps `fiveHourPercent: null` and shows the seven-day percentage with the gate result.
The private fact never enters a response, checkpoint, or log.
An empty reading, an unsupported window, or an invalid weekly percentage remains unknown.

The gate does not read the row's `freshness` label. That label follows each reader's own
bound: the Claude reader marks a reading stale after five minutes, which is also the
interval between provider refreshes (`USAGE_REFRESH_INTERVAL_MS`). A refresh answers the
previous reading while the new request runs, and the monitor commits usage once a
minute. A healthy account therefore carries a `stale` row for about one minute in every
five, with a reading five to six minutes old. While the gate followed the label, it held
manual and queued starts for that minute with `usage_unknown`. Ten minutes is one refresh
interval, one commit, and a margin, so a healthy account never reads unknown, and a
reading that missed a whole refresh does.

A reading that is missing, unavailable, older than ten minutes, or followed by a failed
refresh stays unknown and holds a start. The Start gates section of Queue settings and the capacity strip
show **Unknown** whenever the status is `unknown`, even when a retained seven-day percentage is known.

What a held gate does:

- **Queue.** `queue-next` does not answer the start. Nothing is written, so the task
  waits and no state is shown and later retracted; `queue.gates.next.reasons` says why,
  and so does the task's entry in `queue.waits` (see [Why a task waits](#why-a-task-waits)).
- **Manual start.** `start-plan` answers the fixed `gate_held` before a token is minted,
  after the refusals that precede it (`not_startable`, `unsupported_provider`,
  `unavailable`, `plugin_missing`). The answer names no gate. The renderer names the
  gates that hold the task's provider from the readings `queue.gates` already carries
  ("This task is held: ..."), and falls back to one fixed line that points at the Queue
  view when those readings show no hold. It asks for the board again after the answer, so
  the line is drawn from the newest readings. A reading that is unknown reads "not known
  yet", never as passed. An unknown tree adds fixed pending-or-unavailable feedback and asks the owner to retry after 15 seconds.
  **Start session** stays available; another explicit start requests gate facts again. No held start launches automatically.
  A start held only by the root's uncommitted changes answers the fixed
  `tree_dirty` instead, and the renderer offers
  [a separate worktree](#separate-worktree-for-a-dirty-repository). The queue runner
  treats `gate_held` and `tree_dirty` like a task that moved: no pause, and the next poll
  asks again.
- **Running sessions.** Never touched.

`GET /api/tasks` serves the readings as `queue.gates`. The route rebuilds the block
field by field and drops it whole when one value is outside the contract. A monitor
runtime without the lookup serves no `gates` and holds every start.

## Completion

The agent reports through the Pomegr MCP tool `complete_task`. Pomegr then verifies
the conditions the user checked (the task's **Complete when**, `completeWhen`) and puts
the task in Review. Complete names the agent's report; Done names only the owner's
Mark done. `POST /api/agent/v1/tasks/add` still accepts `doneWhen` as the name an
installed plugin from before the rename sends; a body with both names is `invalid`.

| Condition | Verified by Pomegr |
| --- | --- |
| Pull request open | Committed state of the session's pull requests, the ones its Repository tab lists |
| Working tree clean | Committed repository state of the root or worktree |
| Commit on task branch | Committed Git facts of the task branch |
| Pull request merged | Committed state of the same pull requests |
| CI passed | Check status of the same pull requests, as last read by the monitor |
| Validated with the user | Not verified; the agent validates the work with the user before it reports |
| Own condition | Not verified; the agent judges it in its report |

- **An unblocked completion sets Needs review** (task T-45, 2026-10-10; it replaces the earlier
  rule that a report whose conditions all passed set Done). Whatever the results, with or
  without an attention line, an unblocked card goes to Review with each condition's result, and
  only the owner sets Done, with Mark done (`resolve_done`). The agent can call
  `block_task` with a bounded reason; the state becomes Blocked by agent.
- **Attention line** (GitHub issue #135, 2026-10-10). `complete_task` takes one optional
  input, `attention`: one line of at most 200 characters that names what in the finished
  work needs the owner's attention, such as a choice the agent made for them. It does
  not decide the state: a completion needs review, or stays Blocked under an existing owner hold. The
  checks are verified and stored either way. The line is agent-authored text, bounded
  and validated like the block reason. The store keeps it in its `meta` table under
  `task_attention:<repositoryId>:<taskId>` (`server/tasks/task-attention.mjs`), so the
  schema version stays 1; it is written with the report, removed by Requeue and with
  the task, and kept by Mark done. It is served only as `report.attention` on
  `GET /api/tasks`, shown in the Task modal as the agent's words, and never part of
  the report's answer. A session that ends without a report is
  Stalled once a second reading confirms its end (see [States](#states)).
- **Validated with the user** (`user_validated`, task T-44, 2026-10-11) is a check
  Pomegr cannot observe. The session prompt lists it with the other conditions, and the
  agent judges it like the own condition. `verifyChecks` has no rule for it, so it gets
  no `{ check, passed }` result and no reading on a waiting task. The forms and the
  Task tab label it Agent-reported after a report.
- With no condition checked, the agent's `complete_task` report alone completes the
  task: it has no result to show, and the task still goes to Review.
- **A result is passed, failed, or unavailable** (task T-90, 2026-10-13; it replaces the
  earlier rule that an unknown fact was stored as not passed).
  - Passed is `{ check, passed: true }`: a dated reading shows that the condition holds.
  - Failed is `{ check, passed: false }`: a dated reading shows that it does not hold.
  - Unavailable is `{ check, passed: false, unavailable: true }`: Pomegr has no dated
    reading of the condition. It says nothing about whether the condition holds.
  - `unavailable` is present only when true, and never beside `passed: true`. The store
    rejects any other form, and so does the browser's board parser.
  - A dated reading is a known value whose read time is not earlier than the work that
    could have changed it (see the age rule below). A known failing value read before
    that work is unavailable too: it may have changed since.
  - A result stored before this rule holds no mark. It reads as failed, as it did then.
  - Unavailable is not a pass. It moves no card and completes no task: only the owner
    sets Done.
- The report keeps only these results, the time, the bounded block
  reason, and the bounded attention line. Command output, diffs, and provider payloads are never kept or exposed.
- **A report is verified on a read made when it arrives** (product-owner decision,
  2026-10-10). An agent reports right after its last command, so the facts the monitor
  already holds are older than that command and cannot be judged. When `complete_task`
  arrives for a task that can still be reported on and has a checked condition, the
  monitor reads the bound session's repository and its pull requests once, at that
  moment, and judges the report on that read (`readTaskCheckFacts` in
  `server/runtime/task-session-lookup.mjs`).
  - It is the session's own live repository read (`readNow` in
    `server/repository/session-repository-enrichment.mjs`): the root and branch the
    monitor already bound to the session, the same Git reader and pull-request reader,
    `execFile` with argument arrays, and their own deadlines. Nothing in the request
    names a path, a branch, or a repository. The read reads no provider.
  - The read does not reuse an older answer. The pull-request reader skips its 60-second
    cache (`fresh`), and a Git read that joined an inspection begun before the report is
    made once more.
  - The request waits for the read, for at most 20 seconds. This is the one place a task
    request waits for Git or GitHub: it is the agent's POST, bound to its session. No
    GET reads anything, and a task with no checked condition reads nothing. The
    `complete_task` tool waits 25 seconds for the answer, so it outlasts this read; a
    plugin before 0.9.2 waited 2 seconds and told the agent that nothing was reported
    although the report was recorded.
  - The answer of the read replaces the session's live repository value like any
    refresh, so the next derive commits it. Nothing new is stored or served.
  - **The read follows the branch the bound checkout has** (task T-90, 2026-10-13). A
    session can leave the branch recorded for it: Codex records only its launch branch,
    and an agent in the repository root makes its own task branch there. The live check
    then refuses the checkout as `branch_changed`, and every fact was unknown. In the
    report that showed this, a Codex session launched on `tasks/T-62` ran
    `git switch -c tasks/T-64`; its pull request, clean tree, and passed CI all read not
    passed. When Git answers for the bound root on another branch, the report's read now
    judges the tree, the comparison, and the pull requests of the branch the root has.
    The root must still be the bound one; a read that Git answers for another root
    verifies nothing.
  - That read is the report's alone. It replaces no live repository value, records no
    sidecar, and commits nothing; the Repository tab keeps saying that the branch changed.
    The board's reading of a waiting task still judges the recorded branch only.
  - A read that cannot be made (no bound repository, a failed Git read, the deadline)
    falls back to the committed facts below, which the age rule then judges. A fact that
    is unknown is not a pass and not a failure: its result is unavailable.
  - CI still running when the report arrives is a known `pending`, so the condition
    fails. The agent waits for CI before it reports.
- The board's reading of a waiting task (below) uses committed facts only and never
  blocks on acquisition (`resolveTaskCheckFacts`).
- Both hand the pure rule `verifyChecks(checks, facts)` the same shape,
  `{ treeClean, branchCommits, pullRequestStates, ciPassed, readAt, workAt }`, built by
  one function from a repository block, a pull-request block, and the session's
  committed public state. The task branch is the branch recorded for that session.
  - Working tree clean: the live repository block lists no uncommitted file.
  - Commit on task branch: the branch is not the main branch and its base comparison
    shows a commit of its own, merged since or not.
  - Pull request open, Pull request merged: the ready pull-request block holds a pull
    request in that state. The block is the one the session's Repository tab shows, so
    the two always name the same pull requests (task T-88, 2026-10-12; it replaces the
    earlier rule that only a pull request whose head is the recorded branch counted).
    Its items are the pull requests the session created and those whose head is the
    session's branch (`readPullRequests`). An item with no known state is listed as
    `unknown`: it leaves the condition unavailable unless another item holds the state.
    A ready block that lists no pull request is a known answer, so both conditions fail.
  - CI passed: the monitor's pull-request read (`server/repository/pull-requests.mjs`)
    asks gh for `statusCheckRollup` in the same call and normalizes it to one of
    `passed`, `failed`, `pending`, or `none`: any failed check gives `failed`, otherwise
    any unfinished check gives `pending`, and a pull request with no check gives `none`.
    A missing or unrecognized list is unknown. The condition judges the block's
    open pull requests, or its merged ones when none is open, and passes only when each
    is `passed`. Pending, failed, no check, and no such pull request are known failures; a
    pull request whose status the monitor has not read is unknown. No such pull request is
    dated by the pull-request block's read. The status and the
    time of the read that established it are taken from memory (`pullRequestCheckRead`);
    a report's own pull-request read is what puts them there.
  - An unavailable or historical repository block, a missing base comparison, and a
    pull-request block that is not ready are unknown.
- **A fact is judged only on a read made after the work it judges.** Working tree
  clean, Commit on task branch, and CI passed never pass
  on a fact older than the session's latest work that could have changed it. Pull
  request open and Pull request merged are the exception (task T-88, 2026-10-12): they
  need a dated read and are not compared with the work, so the Task tab never says
  "Not yet" for a pull request the Repository tab lists from that same read. A merged
  pull request stays merged, and an open one that was closed since reads open only
  until the next read, as it does in the Repository tab. Each
  fact carries the time it was read (`readAt`) and the latest work that could have
  changed it (`workAt`), epoch milliseconds from committed memory with no clock, Git,
  GitHub, or provider read. `verifyChecks` passes a fact only when its read time is a
  finite number not earlier than its work time. A missing, malformed, or non-finite read
  time is unknown, a read earlier than the work is unknown, a null work time means no
  relevant work is recorded, and unknown is never a pass. In a report, each unknown is an
  unavailable result.
  - **Read times** come from monitor-private `readAt` stamps that the producers commit
    with the values they date. The repository block's `readAt` is the start of the Git
    read its changed files and base comparison come from; it dates `tree_clean` and, while
    the remote comparison is ready, `commit_on_branch`. The remote comparison's own
    `checkedAt` does not date the local read and is not used. The
    pull-request block's `readAt` is the start of the oldest read its items rest on (the
    served `checkedAt` is the newest and is not used); it dates `pr_open` and `pr_merged`.
    CI uses the oldest judged check-status read, bounded by the pull-request block's
    `readAt`. Every read is dated by the moment it began, because what it saw is no
    newer than that. A report's own read is dated the same way, and it begins after the
    report arrived. Concurrent Git reads of one working tree share one inspection, and
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
    `commit_on_branch` and `ci_passed` are dated by the latest end
    of the session's finished `git`, `git_push`, and `pull_request` execution tasks. A task
    still running or finished at no known time, and a file write with no recorded
    result, make the matching facts unknown. A
    truncated activity feed with no file write bounds the newest write by its oldest item.
    For a report, the work times are taken from the committed state after the report's
    read has answered.
  - **Nothing new is persisted or served.** The times live in the lookup's result and the
    monitor's memory. The `readAt` stamps travel in the committed public state of a live
    session and are removed by `serializeServedSessionState`
    (`server/repository/session-repository-enrichment.mjs`), which is the observation
    store's default serializer and the `/api/state` serializer. The answer of
    `complete_task` still carries only per-condition results: passed, failed, or unavailable.
- **One source for a condition, before and after the report.** While a linked task has
  no report and no outcome (its state is still Not queued, Queued, or Scheduled) and has
  a checked condition, every board that leaves the monitor carries `session.checks`: one
  `{ check, passed }` per checked condition, from the rule of `verifyChecks` on the facts
  `resolveTaskCheckFacts` returns at that read. `fillTaskSessions` computes it with the
  rule that verifies the report, on the committed facts instead of a new read. A runtime without the lookup, a lookup that throws, and a
  lookup with no facts give no reading.
  - It is a reading as of that board, not a result and not a task state. It is never
    stored, it moves no card, and it changes no state. The session's Task tab words it
    as of now ("Holds now", "Not yet") under the heading that says the conditions are
    checked when the agent reports; without a reading the row says "Waiting for report".
    A reading can change with the next read, like the start gates' readings; only the
    report's verification is final.
  - Once a report or an outcome is recorded the board carries no reading, and the Task
    tab shows the report's own results ("Passed", "Did not pass", "Not verified") or
    "No report".
  - The age rule applies to the reading, so CI passed, Commit on task branch, and
    Working tree clean read "Not yet" until their read is later than the session's
    latest work. A report made at that moment is judged on its own read, so it can pass
    a condition the reading still shows as "Not yet". A pull request the Repository tab
    lists reads "Holds now" at once.
  - It carries pass or fail only: no fact, read time, work time, CI status, pull-request
    item, or path. It has no unavailable mark (`readChecks`): "Not yet" already says that
    the condition is not established now.
- Each completion report verifies the conditions once. Pomegr does not repeat verification by itself.
  A later completion verifies them again, for example after CI finishes.
  The owner may also resolve the task with Mark done.
- **Limits, stated plainly.**
  - The work times come from committed state, which can trail the agent by a moment. A
    command that ended just before the report and is still committed as running leaves
    its facts unknown, and the condition reads not verified although it holds. The
    report's read takes long enough that this is rare.
  - The report's read trusts the bound checkout, not the branch. It is a heuristic: when
    another session moved a shared checkout to another branch, the report is judged on
    that branch and its pull requests. A task that runs in its own worktree has no such
    neighbor.
  - The board's reading judges committed facts. A refresh enters the committed state only
    at the next evidence-driven derive, and the store's unchanged-detection ignores the
    stamps, so a derive whose served state is identical keeps the older stamp. The
    reading can therefore say "Not yet" for a condition a report would pass. Read-only
    commands (`gh pr checks`, `git status`) count as work for the reading too.
  - A running execution task of any kind (a dev server, for example) keeps `tree_clean`
    unknown while it runs, and a running Git, push, or pull-request task does the same for
    Commit on task branch and CI passed.
  - Repository work is recognized only as a finished `git`, `git_push`, or `pull_request`
    execution task. A compound or generic shell command, or another tool, that changes
    the branch or a pull request is not counted, and only the newest retained execution
    tasks are seen.
- **The latest accepted report wins** (owner decision, T-142, 2026-10-16). The started session and assigned sessions may replace reports until Done.
  They may alternate `block_task` and `complete_task`, including completion followed by a new block.
  Every completion uses the existing completion-check path, including its bounded fresh read and unavailable results.
  Failed or unavailable checks never become success through the agent's claim.
  Identical reports with identical results change nothing, including timestamps and history.
  A repeated completion may record different results when the facts change.
- **Reporting and owner holds are separate.** A block sets Blocked by agent and holds a running queue.
  A later completion replaces the current report and results but keeps the task Blocked.
  It moves no card, releases no queue, starts no session, and never sets Done.
  The answer names the remaining owner action: Mark done or Requeue.
  These actions retain their existing queue-release rules in [Queue](#queue).
  A queue that is off or paused keeps its status throughout reporting.
- **Owner decisions remain final.** Done refuses reports with `already_reported`.
  Requeue clears the started session's link, so its later report answers `not_found`.
  Assignments retain their existing lifetime; an assigned session may report the requeued task.
  An unrelated or unassigned session cannot replace a report.
  A stalled task with no report still accepts reports under [Assigned sessions](#assigned-sessions).
- **Prior reports stay private.** Before replacing or requeuing a report, the store retains it in `meta`.
  The key is `task_report_history:<repositoryId>:<taskId>`; schema version stays 1.
  Each entry retains the report time, check results, block reason, and attention line.
  The newest 100 superseded reports survive reopening, Mark done, and Requeue; deleting the task removes them.
  The current report remains in the existing fields. Provider transcripts and their observed events remain unchanged.
- The monitor serves the reports as `POST /api/agent/v1/tasks/complete` and
  `/block`, under the gate of `add`. The body is `{ sessionRef }`, plus a one-line
  `reason` of at most 200 characters for a block, or an optional one-line `attention`
  of at most 200 characters for a completion, and optionally `taskId`; any other key is
  `invalid`. The session names the task: the one it was started for, or the one it is
  assigned to. A session with more than one task names the one it reports with
  `taskId`, which must be one of its own tasks. The answer is
  `{ schemaVersion: 1, ok: true, state, results }` (`state` is `needs_review` or
  `blocked`; `results` only for a completion, including one that retains a block) or `{ schemaVersion: 1, ok: false, reason }`
  with `invalid` (400), `not_found` (404, the session has no task, or the named task is
  not one of its tasks), `task_required` (409, the session has more than one task and
  named none), `already_reported` (409), or `unavailable` (503). `stalled` (409) was the
  answer to the started session's report on a task Pomegr stalled; since T-112 the
  monitor no longer sends it, and the plugins still know it for an older monitor. The plugins send `taskId` and know
  `task_required` from version 0.9.8. From version 0.9.9 the `complete_task` tool names the
  conditions that failed apart from those Pomegr could not verify; an older plugin words both as
  not confirmed. The plugins know `stalled` from version 0.9.5; an older
  plugin reads it as an unknown reason and says that Pomegr is unavailable. It never
  carries a task ID, task
  content, or a repository fact. A completion with a checked condition answers after
  its read, within the read's deadline.

## Session binding

A tool call is bound to the calling session by the harness, never by a value the model
supplies.

- **Claude Code**: a `PreToolUse` hook, like `plugins/claude-code/scripts/rename-session.mjs`,
  supplies the session on every call. The hook hands `session_ref` to `add_task`,
  `update_task`, `remove_task`, `assign_task`, `unassign_task`, `complete_task`, `block_task`, and the four feature tools (see
  [Feature context](#feature-context)) through `updatedInput`, together with `session_proof`:
  `<issuedAtMs>.<base64url HMAC-SHA256>` over the tool name, the session reference, and the
  issue time, keyed by the local agent-query capability token
  (`plugin-src/task-binding-proof.mjs`, shared by hook and server). The hook code is
  `bindClaudeQueryWrite` (async; it signs the call or denies it) and
  `bindClaudeQuerySession` (reads only, synchronous, and never binds a write tool). The
  token appears nowhere in the hook's output except as that key.
  - The hook denies a write for one of three causes, each with its own fixed sentence for
    each tool, in the tool's outcome words ("so nothing was reported" for a report):
    - The input holds a field the tool does not take. The sentence names the tool's
      fields and tells the agent to retry once with only those. For `complete_task` it
      adds that a plain completion takes no field.
    - The transcript path gives no session ID. The sentence says that Pomegr found no
      session for the call, and tells the agent not to retry and to tell the user.
    - The hook can make no proof, such as when no token is readable. The sentence says
      that Pomegr could not sign the call and may not be running, and tells the agent not
      to retry and to tell the user.
  - The owner decided on 2026-10-15 (T-122) that the second and third causes get
    separate sentences, because each needs a different fix. A sentence is a constant: it
    never holds an input value, an offending key, an error message, a path, or the token,
    and the proof failure itself is never explained. Before plugin 0.9.10 the hook gave
    all three causes one sentence, which agents read as a broken Pomegr.
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
    permission prompt and the server verifies it after the user approves. In the
    2026-10-10 probe below the hook ran before the permission decision on every call: a
    call denied for want of approval already carried the hook's fields. An approval given
    after a wait has not been exercised on a device.
  - The hook makes no permission decision for a write, so Claude Code decides as it does
    for any MCP tool: in its default mode the user approves each of the write tools, and
    in auto mode Claude Code's own classifier decides. Observed on a device on 2026-10-09
    (plugin 0.9.0): the classifier let ordinary task text through and refused a few calls,
    with reasons that followed the conversation and the free text (`text`, `reason`), not
    the tool name. Calls that carried the same `session_ref` and `session_proof` passed,
    so neither the names nor the hook's fields explain a refusal, and renaming the tools
    would not prevent one. The sample is small and the classifier's reasoning is not
    visible. A refused call posts nothing; the agent stops and tells the user instead of
    rewording the text.
  - Probed on a device on 2026-10-10 (Claude Code 2.1.296, plugin 0.9.3): what changes if
    the hook also returns `permissionDecision: "allow"` for `add_task`, `complete_task`,
    and `block_task`, as it does for the read `get_agent_context`. The probe was a
    temporary local build, deleted afterwards; nothing shipped. It used synthetic text,
    sessions linked to no task, and `claude -p` with no approval surface, where a call
    that needs a prompt is denied and says so. `remove_task` was not probed.
    - Default mode: with no hook decision, 4 of 4 calls needed a prompt. With the hook's
      approval, 10 of 10 calls (at least 3 per tool) ran with no prompt, and the debug log
      recorded `Hook approved tool use …, bypassing permission prompt` for each.
    - Auto mode: with no hook decision, each of 10 calls produced one classifier request,
      and all 10 passed (ordinary text). With the hook's approval, 15 of 15 calls (5 per
      tool) ran with no classifier request and the same bypass line. So a hook approval
      skips the classifier as well as the prompt. The evidence is the absence of a
      classifier request in the local debug log. No call with text that the classifier
      refuses was tried, and anything Claude Code does off the device is not visible.
    - With no hook decision in auto mode, the debug log says that because a hook rewrote
      the call's input, the local classifier judges that one call. The binding through
      `updatedInput` therefore gives every write its own classifier judgment.
    - Claude Code's documentation (read 2026-10-10) says a plugin cannot ship permission
      rules. A plugin's `settings.json` takes effect for two keys only, `agent` and
      `subagentStatusLine`, "and every other key is dropped"
      ([plugin components](https://code.claude.com/docs/en/plugins/components)); the
      manifest has no permission field
      ([plugins reference](https://code.claude.com/docs/en/plugins-reference)). The
      classifier reads `autoMode` from user settings, managed settings, and `--settings`,
      not from a project or a plugin
      ([auto mode configuration](https://code.claude.com/docs/en/auto-mode-config)). A
      hook's `"allow"` "skips the permission prompt", and deny and ask rules "are still
      evaluated regardless of what the hook returns"
      ([hooks](https://code.claude.com/docs/en/hooks)). In auto mode, a call that matches
      the user's allow, ask, or deny rule resolves before the classifier
      ([permission modes](https://code.claude.com/docs/en/permission-modes)); this was
      not probed. The documentation does not say what a hook's `"allow"` does to the
      classifier, so the probe is the only evidence for that.
    - So only two things end an auto-mode refusal: an allow rule that each user adds for a
      tool, or an approval from the Pomegr hook for every user of the plugin.
    - Trade-off, not decided: an approval from the hook ends the default-mode prompt and
      the auto-mode refusal, so a session that nobody watches never waits. In exchange an
      agent writes to the board in every permission mode with no user approval and no
      classifier check, including the free text of `add_task` and the `block_task` reason.
      The user is not asked and can only opt out, with a deny or ask rule. The bounds that
      remain are Pomegr's own: the session proof, reports limited to the session's own
      tasks, and an added task that is last in the first column and not queued. This
      changes the rule in `AGENTS.md` that dispatch never approves work in a running
      session, so it needs the product owner's decision before any code ships.
- **Codex**: the thread identity Codex puts in the `_meta` of every MCP tool call
  (`threadId`, which must agree with `thread_id` in its turn metadata when that is
  present), read by `resolveCodexCallSession` in `mcp/task-tools.mjs`.
  The MCP SDK exposes this metadata at `context.mcpReq._meta`; transport tests verify the binding through the SDK.
  A stdio MCP server
  does not receive `CODEX_THREAD_ID`: Codex 0.157 starts it with an allowlisted
  environment, so that variable is only the fallback. A Codex subagent thread has its
  own identity and therefore no linked task.
- `add_task` targets the board of the task the calling session is linked to. The route
  asks the task store (`sessionTasks`, a read of the task store alone: no Git, provider,
  or path read) for the session's link first and uses the linked task's repository ID; the
  session's committed repository identity is used only when the session is not linked or
  the store cannot answer. So a session started for a task adds to the repository
  whose board holds the task, even when its committed identity is missing, is not
  committed yet, or differs. It never accepts a path or a repository ID.
- The monitor serves `add_task` as `POST /api/agent/v1/tasks/add`, beside the agent-query
  GETs and under the same gate: loopback host, no `Origin` header, and the agent token
  when one is configured. The body is a JSON object of at most 16 KiB with
  `Content-Type: application/json` and only these keys: `sessionRef` (`claude:<id>` or
  `codex:<id>`), `text`, and optionally `run`, `completeWhen`, `feature` (a feature name), and
  `after` (task IDs the new task runs after, see [Runs after](#runs-after)).
  Any other key, including a repository ID or path, is `invalid`. The record rules are
  the store's. The monitor resolves `sessionRef` to a repository from the task link or, for
  a session without one, from the session's committed repository identity, never reading
  Git or provider files, and creates the task as the desktop `create` action does: last in the first column, not queued. A `feature` must
  name a feature of that repository that is not done, exactly; the task joins that feature. A done feature answers `feature_not_found`.
  An agent makes a feature with `create_feature` (see [Feature context](#feature-context)).
- The answer is `{ schemaVersion: 1, ok: true, taskId }` or `{ schemaVersion: 1, ok: false,
  reason }`, never an echo of task content. Reasons: `invalid` (400), `session_not_found`
  (404), `repository_unavailable` (409), `feature_not_found` (404), `limit` (409),
  `after_not_found` (404), `after_loop` (409), and `unavailable` (503). Beside the paths of [Boundaries](#boundaries), no path under
  `/api/agent/v1/tasks/` is served, and no other agent route accepts a write.
- **`add_task` is safe to repeat for five minutes.** Decided for task T-14
  (2026-10-10). An agent whose first answer was
  lost asks again, and that second call must not make a second task (seen on a device on
  2026-10-09: one task was added twice). When the same bound session adds the same task
  text to the same feature again within five minutes of the add, the store answers the
  task it already added and writes nothing. The answer has the same shape, with only the
  task ID.
  - The text is compared as the store keeps it (trimmed), and the feature by its ID. Run
    on, Complete when, and Runs after do not tell two adds apart: the first add's values
    stand.
  - Another text, another session, another feature, or another board makes a new task.
  - The window counts from the add, and a repeated call does not extend it. After it,
    the same call adds a new task.
  - The earlier task is answered only while it still exists and is still recorded as
    added by that session. The owner's edits and moves do not end this; a deleted task
    is never answered, so the same text then makes a new task.
  - The memory is in the monitor's memory only, inside the task store
    (`server/tasks/task-recent-adds.mjs`): for each add a SHA-256 digest of the
    repository ID, the session ID, the trimmed text, and the feature ID, with the task
    number and the time of the add, for at most 256 adds. The task text is not copied
    there. Nothing of it is persisted, logged, or served, and a monitor restart forgets
    it. An add is remembered only after its write committed.
- **A tool says what it knows about a write that did not answer.** The transport
  (`createAgentTaskWriter` in `shared/agent-query-transport.mjs`) tells two failures
  apart, and neither carries an error detail.
  - Nothing was written: the request was not sent, no connection was made, or the
    monitor's gate refused it with a 4xx that is not an answer. The tool says so, for
    example "Pomegr is unavailable, so no task was added."
  - The outcome is unknown: the request was sent and no usable answer came back in time
    (the wait ran out, the connection broke, or the answer was not the route's). The
    monitor may have committed the write. The tool says the outcome is unknown, that the
    agent must not assume a failure, and what is safe: the same `add_task` again within
    a few minutes returns the same task; the same report again, only if it still describes the work;
    the latest accepted report wins; `remove_task` once more with the same
    ID; `update_task` once more with the same input, which sets the same values.
  - The tool writes wait longer than a read, because a write is not repeated by
    itself and a busy monitor commits it and answers late. `add_task`, `update_task`, `remove_task`,
    `block_task`, and the feature tools wait 10 seconds; `get_feature` goes through the
    same transport, so it waits as long, and when it gets no answer it says only that
    nothing was read. After an unanswered feature write the agent reads the feature
    with `get_feature` before it tries again. `complete_task` waits 25 seconds, past the 20
    seconds the monitor may take to read the repository before it judges a report (see
    [Completion](#completion)). Reads keep 2 seconds, and so does the session-start
    `bind`, which runs under the 5-second hook limit. The waits stay under the hosts'
    tool-call limits (Codex: 60 seconds by default); the Claude Code `PreToolUse` hook
    runs before the call and does not bound it.
- A started session carries an opaque random dispatch token in `POMEGR_TASK_TOKEN`. The
  plugin's session-start hook reports the token and the session ID to the monitor, which
  links the task to the session. `complete_task` and `block_task` act only on the task
  linked to the bound session and on the tasks that session is assigned to (see
  [Assigned sessions](#assigned-sessions)). Both plugins run the same hook script on `startup` only;
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
  digest, and bumps the update time, and moves the card to the column with the
  `in_progress` role (see [Columns and card moves](#columns-and-card-moves)). It changes
  no state.
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
tasks to its repository, and it can assign itself to a task of that board (see
[Assigned sessions](#assigned-sessions)). A session that is not linked, but that the user opened inside a
task worktree, adds to the main repository's board: a linked Git worktree takes its main
repository's identity (product-owner decision, 2026-10-10; see
[Repository context inventory](observation-cache.md#repository-context-inventory)). The
identity comes from a Git read of the worktree folder. Once the folder is removed, the
path shape of a Pomegr-made task worktree names the repository, for a repository ID the
inventory already knows.

## Assigned sessions

Task T-97, product-owner decisions of 2026-10-12. The link of [Session binding](#session-binding)
is one task to one session, made only by a dispatch. A session that Pomegr did not start
for a task, such as one the owner starts by hand to resume a task whose first session
stopped responding, is **assigned** to it instead. The relation is many to many: a task
holds at most 16 assigned sessions, and a session is assigned to at most 16 tasks. The
session Pomegr started for a task is its started session, never an assigned one.

- **A marker only.** Assigning and unassigning change no state, column, queue place,
  or update time, and move no card. An assignment is never a dispatch: it does not
  start the task (see [A started task is read-only](#a-started-task-is-read-only)), it
  is not in flight, it holds no queue, and the queue may still start its own session
  for the task. The stall watcher follows only the started session.
- **Which tasks.** Any task of the board that is not Done: one that has not started,
  one with a started session, and one that needs review, is blocked, or stalled. A Done
  task answers `conflict`, and so does the started session assigning itself to its own
  task. Assigning a session that is already assigned answers `ok` and writes nothing.
  A 17th session on a task, or a 17th task for a session, answers `limit`.
- **Which board.** The agent's board is the one `add_task` writes to for that session
  (see [Session binding](#session-binding)), so an agent reaches only its own
  repository's board, and no input names a repository, a path, or a session. The
  owner's action names a session; the route accepts it only when the monitor's
  committed memory holds that session for the board's repository
  (`resolveTaskSession`), and answers `not_found` for any other.
- **What an assigned session may do.** It reports the task with `complete_task` or
  `block_task`, and reads its feature with `get_feature`. It gets no prompt from
  Pomegr. It may read the task's text with `get_task`, as any session of the board may
  (see [Agent task read](#agent-task-read)).
- **The latest report wins** under [Completion](#completion). The started session and assigned sessions may update reports until Done.
  An updated completion never clears an existing owner-controlled block.
- **A stalled task.** An assigned session may report a task that Pomegr stalled,
  because it is the session that resumed the work. A completion sets Needs review,
  moves the card to Review, and frees a queue the stall blocked (`releaseQueue`); a
  block sets Blocked by agent, which keeps holding the queue. The started session may
  report it too; later reports follow [Completion](#completion).
- **A task that has not started.** A report from an assigned session sets the outcome
  as for any task and takes the task out of the queue. The same write clears a
  dispatch that has not linked, so a start still in flight links nothing: its
  session-start `bind` answers `not_found`, and that session runs unlinked.
- **Several tasks.** A session with more than one task (the one it was started for and
  the ones it is assigned to) names the task in `complete_task`, `block_task`, and a
  `get_feature` without a feature, with `task_id`. Without it the answer is
  `task_required`. A task that is not one of its own answers `not_found`.
- **Conditions are verified on the reporting session.** The report's read and the
  board's committed facts are those of the session that reports: its own repository
  root and branch (see [Completion](#completion)). The task's worktree and branch
  rules do not apply to an assigned session: Pomegr creates, checks, and removes no
  worktree or branch for it. The board's reading of a waiting task (`session.checks`)
  still comes from the started session only.
- **Requeue, Mark done, delete.** `resolve_requeue` keeps the assignments, so an
  assigned session may report the task again; it clears only the started session's
  link. `resolve_done` keeps them for the record. `delete` and `remove_task` remove
  them with the task.
- **Pomegr controls nothing.** An assigned session is never started, stopped,
  answered, or approved by Pomegr. Observation stays read-only: the relation is a
  projection of the task store, and no observation module reads it.

The store actions are `session_assign` and `session_unassign`, each with exactly
`{ id, sessionId }`. They are in the fixed action list, so the desktop IPC and the
paired-device route accept them (see [Boundaries](#boundaries)). `session_unassign`
answers `not_found` for a session that is not assigned to the task.

The agent tools `assign_task` and `unassign_task` take only `task_id`. The monitor
serves them as `POST /api/agent/v1/tasks/assign` and `/unassign`
(`server/serving/task-session-routes.mjs`), under the gate of `add` and with the same
content-type check. The body is a JSON object of at most 1 KiB with exactly
`sessionRef` and `taskId`. The answer is `{ schemaVersion: 1, ok: true }` or
`{ schemaVersion: 1, ok: false, reason }` with `invalid` (400), `session_not_found`
(404), `repository_unavailable` (409), `not_found` (404), `conflict` (409, assign
only), `limit` (409, assign only), or `unavailable` (503). It never carries task
content, a state, or who else is assigned. The hook binds and signs both like any task
write and makes no permission decision for them. The tools are in the plugins from
version 0.9.8.

The owner assigns and unassigns in the Task modal, in the desktop app and on a paired
device ([Task modal design](../design/task-modal.md) owns the control). The modal
offers the repository's ten newest sessions that are not Closed and not on the task
yet. They come from one Sessions directory read the client already may make
(`GET /api/sessions?mode=directory&repositoryId=…`, one page of 50) when the modal
opens; a session outside the ten assigns itself with `assign_task`.

Not yet proven on a device: an assign from a real Claude Code or Codex session, and a
report from an assigned session on a stalled task.

## Agent task removal

`remove_task` lets an agent delete a task it added itself, such as a duplicate. On
2026-10-09 an agent added the same task twice (T-12 and T-13) and only the owner could
delete one, in the desktop app. It is the fourth agent write. Deleting cannot be undone,
so the product owner settled the rules below on 2026-10-10 (task T-15).

- **Which tasks.** Only a task the calling session added itself through `add_task`, and
  only while it waits: Not queued, Queued, or Scheduled, with no linked session, no start
  in flight (a dispatch minted less than ten minutes ago), and no report. The first
  proposal stopped at Not queued. The product owner widened it: the owner may ask the
  session that added a task to remove it after having edited it, moved its card, or
  queued it, so none of those ends the session's right.
- **Never.** A task the owner made in the desktop app, a task promoted from a GitHub
  issue, a task another session added, and a task that started, was reported on, or has
  an outcome (Needs review, Stalled, Blocked by agent, Done). A linked session may be
  working, so a started task is left to the owner. The task a session was started for is
  not one it added, so a session cannot remove its own task. No confirmation lets an
  agent remove one of these tasks. The desktop **Delete task** is the only other way to
  delete a task.
- **Who else removes a task.** No GET, queue step, session start, or hook removes a
  task. A browser never removes a task. A paired device removes a task only through the
  owner's `delete` action (see [Paired devices](#paired-devices)).
- **How "added by this session" is known.** The task store records the session:
  `task_added_by:<repositoryId>:<taskId>` in the `meta` table, with the normalized
  session ID as the value, written by the store action `agent_create` in the same
  transaction that creates the task. The alternative was to remember it in monitor
  memory only. That was rejected: the monitor restarts with the desktop app and with
  every update, a session often outlives it, and the duplicate would then stay until the
  owner deleted it, which is the defect this tool is for. The record is one bounded
  value per agent-added task, lives where the task's session link already lives, goes
  when the task is deleted, and is never served. A task added before the record existed
  has none, so no session can remove it.
- **Input.** One task ID (`T-` and a number from 1 to 999999999) and nothing else: no
  repository ID, path, or text. The calling session is bound as for `add_task`
  (see [Session binding](#session-binding)), and the board is the one `add_task` writes
  to for that session.
- **Answer.** Removed, or one fixed refusal. Every refusal after a well-formed request
  is the same `not_found`: the task does not exist, the owner or another session added
  it, it started, or the session has no board. The answer therefore tells nothing about
  a task the session did not add. It never carries a task ID, task text, a state, or who
  added a task.
- **Confirmation.** None from Pomegr for a task inside these limits. Claude Code still
  asks the user to approve the call as it does for any MCP write, and the tool is
  annotated as destructive. Anything wider (a task the session did not add, a started
  task) would need a desktop confirmation and is not built.

How it is built:

- The store actions `agent_create` and `agent_remove` (`server/tasks/task-store.mjs`)
  are store only, like `promote_issue`: they are absent from the fixed action list, so
  the desktop route and the IPC channel never accept them. `agent_remove` checks the
  rule inside the store's transaction and then runs the desktop `delete`: the task
  number stays retired, the cards after it close up, the task leaves its parallel group,
  the task's source, attention line, image list, and added-by record go in the same write,
  its image files go after the commit, the waiting queue cards are settled in Ready, and
  a queue blocked or paused at the task is released, so the queue banner no longer names
  a task that is gone.
- The monitor serves it as `POST /api/agent/v1/tasks/remove`, under the gate of `add`
  and with the same content-type check. The body is a JSON object of at most 1 KiB with
  exactly `sessionRef` and `taskId`; any other key, a query string, or an ID outside the
  pattern is `invalid`. The answer is `{ schemaVersion: 1, ok: true }` or
  `{ schemaVersion: 1, ok: false, reason }` with `invalid` (400), `not_found` (404), or
  `unavailable` (503).
- The MCP tool is `remove_task` in `mcp/task-tools.mjs`, with the one input `task_id`.
  The Claude Code hook binds and signs it as its own tool name
  (`plugin-src/claude-query-session.mjs`), so a proof made for `add_task` does not
  remove anything; Codex binds it from the call's thread identity. The tool is in the
  plugins from version 0.9.1. An older plugin has no such tool, and starting a task
  still needs only 0.9.0.

## Agent task update

`update_task` lets an agent edit a task that is already on the board. Before it, only
the desktop Task modal could change a task, so an agent that had a finding for a task
had no way to add it. It is the agent write for task T-55, and the product owner settled
the rules below on 2026-10-11.

- **Which tasks.** Any task on the calling session's board: one the owner made, one
  promoted from a GitHub issue, and one any session added. The right does not depend on
  who added the task, so the added-by record of
  [Agent task removal](#agent-task-removal) is not read.
- **Only while the task waits.** Not queued, Queued, or Scheduled, with no linked
  session and no start in flight (a dispatch minted less than ten minutes ago). This is
  the rule of the desktop `update` action (`rowStarted` in
  `server/tasks/task-record.mjs`): the session was started from the stored task, so a
  later edit would never reach it. A task that started, was reported on, or has an
  outcome is refused. A requeue makes it editable again. The task a session was started
  for has started, so a session cannot update its own task.
- **What it changes.** The task text, **Run on** (`provider` and `model`), **Effort**,
  **Complete when** (`complete_when` and `own_condition`), and what the task runs after
  (`runs_after`, task T-111; see [Runs after](#runs-after)). It never changes the
  task's feature, group, column, position, queue state, schedule, images, Remote Control,
  or the keep-worktree setting, and it never queues or starts the task.
- **Replace, not append.** A field that is set replaces the stored one whole. A field
  that is left out stays as it is. An empty `complete_when` list clears the checks, and
  an empty `own_condition` clears the own condition. The provider, the model, and the
  effort cannot be cleared. An empty `runs_after` list clears what the task runs after.
  - The agent reads the task with `get_task` first, then sets the whole text (task
    T-118, 2026-10-15). The tool description says so. Before T-118 no agent tool read a
    task's text, so an agent replaced text that it could not read back.
  - A new text that leaves out an image marker (`[image:<id>]`) leaves the image
    attached to the task. `get_task` shows a marker as `[image]`, so a text set back
    from a read keeps the image but loses its place in the text. The session prompt still lists the image, without a place for
    it in the text.
  - A provider that is set without a model clears the stored model, because a model
    belongs to its provider. A change to Codex turns the task's Remote Control off,
    because Codex has none.
- **Bounds.** The record rules are the store's, shared with the desktop `update`: the
  text is at most 4000 characters with no control character, the own condition at most
  500 characters, the checks come from the fixed list, and a model needs a provider.
- **Input.** One task ID (`T-` and a number from 1 to 999999999) and at least one of
  the fields above. There is no repository ID, path, or feature input. The calling
  session is bound as for `add_task` (see [Session binding](#session-binding)), and the
  board is the one `add_task` writes to for that session.
- **Answer.** Updated, or one fixed refusal. It never carries the task's text, a stored
  field, a state, or who added the task. A task that does not exist and a task that
  started answer the same `not_found`, so the answer tells nothing about a task.
- **Confirmation.** None from Pomegr. Claude Code asks the user to approve the call as
  it does for any MCP write, because the hook makes no permission decision for it.

How it is built:

- The store action `agent_update` (`server/tasks/task-store.mjs`) is store only, like
  `agent_remove`: it is absent from the fixed action list, so the desktop route and the
  IPC channel never accept it. It takes exactly `id` and at least one of `text`, `run`
  (`provider`, `model`, `effort`), `completeWhen` (`checks`, `own`), and `after`. It
  checks the rule inside the store's transaction, fills each absent field from the stored
  row, and then runs the desktop `update`, so the validation is that action's. A call with
  only `after` skips `update`. `after` then runs `after_set` in the same transaction.
- The monitor serves it as `POST /api/agent/v1/tasks/update`, under the gate of `add`
  and with the same content-type check. The body is a JSON object of at most 16 KiB with
  `sessionRef`, `taskId`, and at least one of `text`, `run`, `completeWhen`, and
  `after`; any other key, a query string, or an ID outside the pattern is `invalid`. The
  answer is `{ schemaVersion: 1, ok: true }` or `{ schemaVersion: 1, ok: false, reason }`
  with `invalid` (400), `session_not_found` (404), `repository_unavailable` (409),
  `not_found` (404), `after_not_found` (404), `after_loop` (409), or `unavailable` (503).
- The MCP tool is `update_task` in `mcp/task-tools.mjs`. The Claude Code hook binds and
  signs it as its own tool name (`plugin-src/claude-query-session.mjs`), so a proof made
  for another tool does not update anything; Codex binds it from the call's thread
  identity. The tool waits 10 seconds like the other writes. The same input again sets
  the same values, so a call that got no answer is safe to repeat. The tool is in the
  plugins from version 0.9.6. An older plugin has no such tool. `runs_after` on
  `add_task` and `update_task` is in the plugins from version 0.9.12.

## Agent task read

`get_task` and `list_tasks` let an agent read the tasks of its own board. Before them,
`update_task` set text that the agent could not read back. They are the agent reads
for task T-118, and the product owner settled the rules below on 2026-10-15.

- **What a read answers.** For each task: its ID, text, own condition, Complete when
  checks, provider, model, effort, feature title, column name, state, `editable`, and
  `runsAfter`, the IDs of the tasks it runs after (task T-111, 2026-10-15; an empty list
  when none), so an agent holds the whole list before `update_task` replaces it.
  `editable` is true when `update_task` can change the task: the rule `rowStarted`
  of `task-record.mjs`, the rule of the desktop `update` action. A list entry also
  says whether its text was cut (`textCut`).
- **What a read never answers.** A report, an attention line, a block reason, the
  linked or an assigned session, an image or its ID, who added the task, a schedule,
  a path, a token, or a repository, column, or feature ID. An image marker reads
  `[image]` (`plainTaskText`), as on every surface but the Task modal.
- **`get_task`** reads one task by its ID: `T-` and a number from 1 to 999999999. It
  answers the whole text, at most 4000 characters. It reads any task of the board, in
  any state, Done included.
- **`list_tasks`** lists every task of the board, Done included, in board order:
  column, then card. It answers at most 100 tasks, the number that matched, and
  whether the list was cut. A text over 300 characters is cut to 299 and `…`; the
  agent reads it whole with `get_task`.
- **The list's search.** It takes no input, or any of four filters, and a task must
  match each filter that is set. `query` is one line of 1 to 80 characters, matched
  in any case against the text and the own condition. `state` is one task state,
  `feature` an exact feature title, and `editable` a boolean. The owner asked for the
  search so that a whole board does not fill the session's context.
- **Which board.** The board is the one `add_task` writes to for that session (see
  [Session binding](#session-binding)). No input names a repository, a path, or a
  session. A task that does not exist and a task of another board answer the same
  `not_found`.
- **Read only.** Neither tool writes, moves, queues, starts, or steers anything. A
  board that was never written lists no task, and the read seeds no column.

How it is built:

- The store's `readAgentTasks(repositoryId)` projects the stored rows as a board read
  does, without seeding, and builds the entries with `agentTaskEntries` of
  `server/tasks/task-agent-read.mjs`. It answers null when the store cannot be read.
- The monitor serves them as `POST /api/agent/v1/tasks/get` and
  `POST /api/agent/v1/tasks/list`, under the gate of `add` and with the same
  content-type check (`server/serving/task-agent-read-routes.mjs`). The body is a JSON
  object of at most 1 KiB with `sessionRef` and, for `get`, `taskId` only, or, for
  `list`, only the four filters. Any other key, a query string, or a value outside its
  bound is `invalid`.
- The answer is `{ schemaVersion: 1, ok: true, task }` for `get`, and
  `{ schemaVersion: 1, ok: true, tasks, matched, truncated }` for `list`. A refusal is
  `{ schemaVersion: 1, ok: false, reason }` with `invalid` (400), `session_not_found`
  (404), `repository_unavailable` (409), `not_found` (404), or `unavailable` (503).
- `servedAgentTask` of the route module is the one served-task shape. It bounds each
  field again on the way out, as `servedFeature` does, and an entry outside the shape
  answers `unavailable`. The agent chat's `get_task` (task T-104) uses the same route
  and shape. This supersedes the line of T-104 that kept the tool off the plugin's
  server.
- The MCP tools are in `mcp/task-tools.mjs`. The Claude Code hook binds and signs
  each as its own tool name, and approves both (`permissionDecision: "allow"`) as it
  approves `get_feature`: they read the session's own board and change nothing. Codex
  binds them from the call's thread identity. The tools are in the plugins from
  version 0.9.11. An older plugin has no such tools.
- Both reads use the shared task POST transport (`shared/agent-query-transport.mjs`),
  whose exact path allowlist includes `tasks/get` and `tasks/list`. Plugin 0.9.11 and
  0.9.12 omitted both paths, so the transport refused them before discovery or a
  network request and the tools answered the fixed unavailable text even when the
  monitor was running. Plugin 0.9.13 fixes that omission for both providers.
- The transport reads the local runtime descriptor on every call. A later call uses
  a newly published loopback origin and capability after a runtime restart; it never
  caches either in the MCP process or falls back from an invalid descriptor. Claude's
  proof is also checked against the current capability, so a proof from before the
  restart is refused; a fresh hook-bound call can read again. There is no automatic
  write, retry, session start, or lookup of another repository during recovery.
- A missing task or a task of another board answers `No such task on this session's
  board.` An unreachable runtime, an unusable answer, or the route's `unavailable`
  answers `Pomegr is unavailable, so no task was read.` Neither result establishes
  the other. Binding, unknown-session, and unresolved-repository refusals keep their
  separate fixed feedback. No response includes transport or runtime evidence.

## Starting a session

Starting is explicit and runs on the desktop computer.

1. A manual start shows a native confirmation in the desktop app or a browser confirmation on the paired device.
   A start the owner applied from an agent-chat proposal in the desktop app is a manual
   start with the same native confirmation after Apply (see [Agent chat: Session start](agent-chat.md#session-start)).
   The queue runner starts without a prompt
   only after the user turned the queue on.
2. The runner opens a visible terminal window in the repository root, or in the task's
   worktree, that runs the provider CLI. It uses `spawn` with an argument array and
   `shell: false`. Task text is untrusted user content and is never interpolated into
   a command line or a path.
3. The session prompt is a fixed template holding the task text, the files of the
   task's images when it has any, the Complete when list, and
   the instruction to call `complete_task` or `block_task`. For a task that belongs to
   a feature it also holds one fixed line with the feature's title and ID and the
   instruction to call `get_feature` for the feature's description or app version;
   neither of those two fields enters the prompt. For a task promoted from a
   GitHub issue it also holds one fixed line with the issue number, asking for
   `Closes #<number>` in the pull request. Only the integer from the task store enters
   that line, and no issue is read when a session starts.
4. The start is refused with a fixed reason when the Pomegr plugin is not installed in
   the repository or is older than the first version with the task hook and tools
   (fixed result `plugin_missing` for both), a gate holds (fixed result `gate_held`, or `tree_dirty` when only
   the repository root's uncommitted changes hold it), a worktree reused for the
   task has uncommitted changes (fixed result `worktree_dirty`), or the platform is not
   Windows (fixed result `unsupported_platform`).

Built so far: the manual and the queued start of a Claude Code or Codex session behind the start gates, and the link of the started session to its task.

- The renderer calls the fixed IPC channel `pomegr:task-start` with a repository ID and a
  task ID, and for a [separate-worktree start](#separate-worktree-for-a-dirty-repository)
  the fixed third argument `true`; any other third value answers `invalid`. It gets back
  one fixed status and nothing else: `started`, `cancelled`,
  `unsupported_platform`, `cli_missing`, `plugin_missing`, `not_startable`, `gate_held`,
  `tree_dirty`, `unsupported_provider`, `not_found`, `busy`, `invalid`, `unavailable`,
  `failed`, or `worktree_dirty`.
- Desktop main checks the platform and looks for the Claude Code and Codex executables.
  An IPC start then shows the native confirmation. A paired start was already confirmed on the requesting device. Only after the user
  confirms does it ask the monitor for the start plan, because the plan mints a
  single-use token. The provider is therefore known only from the plan: with no provider
  executable installed an IPC start answers `cli_missing` before the native confirmation, and when
  the plan's own provider executable is missing desktop main aborts the dispatch and
  answers `cli_missing`.
- `POST /internal/tasks/start-plan` answers the plan for a startable task: provider,
  model, effort, whether the session starts with Remote Control (`remoteControl`, true only for a
  Claude Code session whose task asks for it), the repository root resolved monitor-side, whether the session must run
  in a worktree of its own (`worktree`: true for a member of a parallel group and for a manual start that asked for one), the prompt, the absolute files of the task's images (`images`, at most four, only files that exist with their listed size), and the dispatch token. A task is startable when its state is `not_queued`, `queued`, or `scheduled`, no
  session is linked, and no dispatch is live. A task with no provider starts Claude Code;
  a Codex task starts Codex, and any other provider value answers
  `unsupported_provider`. The monitor refuses with `plugin_missing` unless the committed
  plugin setup of the repository shows the Pomegr plugin of that provider installed,
  ready, enabled, and at version 0.9.0 or later (`MINIMUM_TASK_PLUGIN_VERSION` in
  `server/runtime/task-start-lookup.mjs`, the first version with the bind hook and the
  task tools; the Claude Code and Codex plugins share the version). An older plugin
  reuses `plugin_missing`, for the manual start status and the queue pause reason
  alike. A version that is unknown or cannot be compared is unknown and holds the
  start like a missing plugin, never a pass. The monitor refuses with `unavailable` when it has not identified the
  repository's root in the current run. Last, it refuses with `gate_held` when a
  [start gate](#start-gates) holds the task, or with `tree_dirty` when the only hold is
  the root's uncommitted changes and the payload does not ask for a worktree.
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
  prompt as one argument, each quoted by the Windows command-line rules. A task with
  images adds one flag after the prompt, because both flags take a list of values and
  would swallow a prompt that followed them: Claude Code gets `--add-dir` with the
  folder of the images, so its read tools may open the files the prompt lists, and
  Codex gets `--image` with the files, which attaches them to the prompt. Desktop main
  uses the plan's images only when each is an absolute, normalized path with a
  store-made file name (`img-<12 hex>` and one of four extensions), all in one folder,
  an existing file, and named in the prompt; otherwise the plan is malformed. A Claude
  Code plan with `remoteControl` adds the one fixed flag `--remote-control` after the
  prompt and before the image flag: the flag takes an optional session name, so before
  the prompt it would take the prompt as that name. Pomegr passes no name. A
  `remoteControl` that is not a boolean, or is true on a Codex plan, makes the plan
  malformed. Remote Control is Claude Code's own feature: the session registers itself
  with the owner's Claude account, and Pomegr never connects to it, reads its remote
  identifier for this, or sends anything to it (the read-only status exception in
  [Claude session status](claude-session-status.md) is unchanged). Claude Code
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
- Starting never changes the task's state or column. The card moves
  only when the started session links.
- The agent chat is a second caller of the same manual start (task T-72, 2026-10-12).
  When the owner applies a `start_session` proposal in the desktop window, desktop main
  calls `startApproved` with that window's event, the repository ID, and the task ID,
  and never a separate-worktree start. The trusted-frame check, the start plan, every
  refusal above, and the launch slot are the same, and the chat gets back the same one
  fixed status. Apply approves the proposal; the shared native dialog confirms the start (task T-147, 2026-10-16). A paired device cannot apply such a proposal, and the
  queue is not touched.
- The New task modal's **Create and queue** and **Create and start session** (task T-83,
  2026-10-12) add no action, channel, or route. The renderer sends `create` and, once
  the monitor answers the new task's ID, the existing `queue_add` for that ID or the
  same manual start, with its confirmation. A create that fails sends neither. When
  the follow-up does not happen, the task stays as created: first column, not queued.
- After a manual start answers `worktree_dirty`, the task modal shows **Open folder**. It
  calls the fixed channel `pomegr:task-worktree-open` with the repository ID and task ID
  only and shows one line per fixed result (`opened`, `not_found`, `invalid`,
  `unavailable`); the **Queue paused** banner offers the same button when the pause reason
  is `worktree_dirty`, and its result line lasts only as long as that pause. Desktop main resolves the folder (the task's worktree directory,
  which must exist and be listed by Git on the task branch) and opens it with
  `shell.openPath`; Windows only. No path, command, or error text crosses the channel.

Claude Code and Codex are both startable. Pomegr never attaches to, writes input to,
approves for, or stops the started process; afterwards it only observes the session
like any other.

## GitHub issues

Decided by the product owner on 2026-10-09. Pomegr's own task store stays the source of
truth for execution: GitHub is a source of task text and a destination for it, never a
source of task state. The monitor, the desktop channel, and the interface that lists
issues, promotes one, and creates one from a task are built. Creating an issue is
Pomegr's first and only write to an external service; nothing else is written to GitHub.

- **Connection.** Pomegr never reads, stores, refreshes, or forwards a GitHub token. Every
  read, and the one write, runs as the owner through the installed GitHub CLI, so a
  private repository works when the owner's `gh` session can read it. `server/repository/issues.mjs` calls `gh`
  with `execFile`, an argument array, a deadline, and an output size cap. The connection
  is `connected`, `not_signed_in`, or `cli_missing`. A repository's access is a
  visibility (`private`, `public`, `unknown`) and capabilities from `read_issues`,
  `create_issues`, `issues_disabled`, and `no_access`. No username, path, command, URL,
  or error text leaves the reader.
- **Which repository.** Every GitHub call names the repository the CLI resolved in that
  same read. The reader runs `gh repo view --json nameWithOwner,...` once per call (the
  same command that reports visibility and capabilities) and builds the list, the single
  read, and the create as `gh api repos/<owner>/<name>/...` from that answer. It never
  leaves `{owner}/{repo}` for `gh api` to fill, because the CLI may resolve that
  placeholder by a different rule than `repo view` (in a fork clone with an `upstream`
  remote the two can differ). Owner and name must each match `^[A-Za-z0-9._-]{1,100}$`, with exactly one `/`,
  no `..`, and no `.` part. They are validated before use and stay monitor-private: no
  result, log, or error carries them. A failed read of the repository answers the same
  fixed status the following call would have (`cli_missing`, `not_signed_in`,
  `issues_disabled`, `no_access`, else `unavailable`, which a create reports as `failed`),
  and a name that is missing or invalid is `unavailable` (`failed` for a create) and
  starts no `gh api` call, so a create is never sent. A write therefore goes only to the
  repository whose visibility and capabilities were read.
- **When a read happens.** Only on an explicit desktop operation: `status`, `list`, or
  `promote` on the `pomegr:task-issues` channel. No GET, queue step, session start, or
  agent tool reads GitHub.
- **The list.** At most 100 open issues; a pull request is never an issue. Each issue is
  normalized to its number, a one-line title of at most 200 characters, the body cut to at
  most 20000 characters for the preview with a `bodyTruncated` flag (true when the
  original body was longer than that), the hidden HTML comments in that body (their
  count and at most 64 ranges), the character count of the task text a promote would
  store, a too-long flag (also true whenever `bodyTruncated` is, so a cut body is never
  promoted), an author association (`owner`, `member`, `collaborator`, or
  `outsider` for anything else), the update time, and a SHA-256 digest of the original
  title and body. `server/runtime/task-issues.mjs` holds the last list in memory for at
  most 16 repositories. It is never persisted.
- **Promote.** The caller sends a repository ID, an issue number, and the digest of what it
  showed. The monitor reads that one issue again. A different digest, or an issue that is
  already promoted, answers `conflict`; an issue that is gone, closed, or a pull request
  answers `not_found`; task text over 4000 characters answers `limit` and is never
  truncated. The caller never supplies task text.
- **Snapshot, not reference.** A promote copies the title, a blank line, and the body with
  its HTML comments removed into ordinary task text, in the first column. Comments on the
  issue are never read. The task text can then be edited like any other. The store keeps
  the source in its `meta` table under `task_source:<repositoryId>:<taskId>`, so the
  schema version is unchanged, and deletes it with the task; an issue whose task was
  deleted can be promoted again.
- **Creating an issue.** Decided by the product owner on 2026-10-09. The `create`
  operation takes a repository ID and a task ID and nothing else; the caller never
  supplies a title or a body. The monitor reads the task's text from the store. The title
  is the first line of that text as one line of at most 120 characters, and the body is
  the whole task text. `createIssue` in `server/repository/issues.mjs` posts them through
  `gh api` to the repository that call just named (see Which repository), with the JSON on
  standard input, so no task text is in a command line, and with a 20 second deadline. On success the store records the source
  (`record_issue`, a store action only, like `promote_issue`) and the task shows the
  `#N` chip. A task that already has a source, or that has a create in flight, answers
  `conflict`; a task that is gone answers `not_found`. A failure answers one fixed
  reason (`cli_missing`, `not_signed_in`, `no_access`, `issues_disabled`, `failed`) and
  changes neither the task nor the store. The text is sent once: later edits to the task
  are never sent, the issue is never read back, and nothing is retried by itself. It
  runs only on the explicit desktop action. No GET, queue step, session start, or agent
  tool creates an issue, and `add_task` stays local.
- **Sign-in.** `sign_in` is an explicit native action behind a native confirmation, on
  Windows only. It opens the GitHub CLI's own sign-in in a visible terminal with `spawn`,
  a fixed argument array, and `shell: false`, and answers one fixed status (`opened`,
  `cancelled`, `cli_missing`, `unsupported_platform`, `unavailable`). It takes no command,
  path, or URL from the renderer and never reads or forwards a credential.
- **Accepted risk.** The prompt's issue number lets the started agent read the whole issue
  thread with its own `gh`, including comments Pomegr never copied. The product owner
  accepted this on 2026-10-09.

### Interface

The interface exists only in the desktop app. A browser has no `pomegr:task-issues` bridge,
so it reads nothing and says that issues are read in the desktop app.

- **Promote issues page.** `/tasks/issues?repository=<repository ID>` lists the open issues
  of one repository on the left and shows the selected issue's raw body, with its notices,
  on the right. Title and body are drawn as React text nodes, never as Markdown or HTML,
  and nothing links to an issue. It reads GitHub only on an explicit action: when it opens,
  when Refresh is pressed, when the Task modal's Show new version asks for the list again,
  and once after a promote finishes, so the row reads Promoted. It never reads on a timer,
  on focus, or from a GET. Promote opens the Task modal for that one issue.
- **Promote mode of the Task modal.** The modal handles one issue and never lists issues.
  Promote sends only the issue number and the digest of what the page showed. `conflict`
  (the issue changed since it was shown, or it is already promoted) creates no task and
  offers Show new version, which shows the issue as it is now. `limit` (the task text
  would pass 4000 characters) names the limit and creates no task; the text is never cut.
  After the task exists the modal sends one update holding only what differs from the
  task the monitor made (feature, run, complete-when), and none when nothing differs.
  If that update fails the task still exists: the modal says so and offers only Close, so
  an issue is never promoted twice.
- **Creating an issue from the Task modal.** In the new mode the modal reads the GitHub
  status once when it opens. When the repository can create issues it shows **Also create
  a GitHub issue**, unchecked, with one line saying that the text is sent once and who can
  read it; otherwise the box is disabled with one fixed reason. **Create task** creates
  the task first and asks for the issue only after the task exists. If the issue fails,
  the modal closes on the created task, which has no chip. In the edit mode a task with
  no source offers **Create GitHub issue**, disabled while the draft is unsaved because
  the monitor sends the saved text. A failure shows its fixed reason as one line, kept
  in renderer memory only, and the action stays offered. Opening a task reads nothing
  from GitHub.
- **The `#N` chip.** A task with a source shows a `#N` chip right after its ID on a board
  card and on a card of the Queue view (`TaskIssueChip`: the shared outline chip with a circle-dot
  glyph and the number in the data font). The session view's Task tab shows one
  Source line: `Source`, the chip, then `GitHub issue`. It reads
  `Task.source` from a ready board only, and shows no promote time because none is stored.
  The chip is a label: Pomegr builds no link to an issue.
- **Sessions list.** The Task cell prints the number as plain muted text after the task ID,
  with no chip, border, icon, or link, so the ID stays the one prominent identifier. The
  number is the nullable `issue` field of the row's task reference. The monitor joins it at
  serving time from the task store's `task_source` row through `readTaskSource`, under the
  same gate as the rest of `task`: a same-computer client or a paired device gets it, and any other client
  gets no `task` key at all. It is not written to the session catalog, a checkpoint, or the
  shell feed, and it is never an issue title or body.
- **Settings → GitHub.** The pane shows the fixed connection (`connected`, `not_signed_in`,
  `cli_missing`) and the repository's fixed visibility and capabilities, never a username,
  path, or error text. **Check again** asks for the status once. **Sign in with GitHub CLI**
  runs the native confirmation and the `sign_in` operation described above. Its reads
  follow the rule above: an explicit desktop action, never a timer, focus, or GET.

## Images

A task can hold images, so the owner can show the agent a screenshot or a mock-up
(task T-25, 2026-10-10). They are user-authored content, the same data class as the
task text, and they are a desktop and paired-device feature: a same-computer browser neither
sends nor receives one. A paired device (task T-77, 2026-10-12) attaches, removes, and reads
them through the gateway's own routes (see [Paired devices](#paired-devices)).

- A task holds at most four images of at most 5 MiB each: PNG, JPEG, GIF, or WebP.
  `sniffImageType` in `server/tasks/task-images.mjs` decides the type from the leading
  bytes. A declared type or a file name is never trusted, and anything else (SVG
  included) is `invalid` before a byte is written.
- The bytes are files beside the database:
  `tasks-v1/images/<repositoryId>/<taskId>/<imageId>.<png|jpg|gif|webp>`. The image ID
  is `img-<12 hex>`, validated by the monitor. No part of a file name comes from text the user typed.
- The task's list, `[{ id, type, bytes }]`, is kept in the `meta` table under
  `task_images:<repositoryId>:<taskId>`, so the schema version does not change. The
  list is the authority: a file no list names is never served, and a listed image
  whose file is gone, or no longer has its listed size and type, reads as
  `not_found`. An entry outside the contract is dropped from the projection instead
  of making the board unavailable.
- An add writes the file first (a `.part` file, then a rename) and the list in one
  transaction after it; a refused or failed list write removes the file again. A
  remove changes the list first and deletes the file after. Both set the task's
  update time. `delete` drops the list in its own transaction and removes the task's
  folder once it has committed. A task number is never reused, so a file left behind
  by a failed removal is never served for another task.
- `openTaskStore` returns `addImage(repositoryId, { taskId, bytes })`,
  `removeImage(repositoryId, { taskId, imageId })`, and
  `readImage(repositoryId, { taskId, imageId })`. Each answers a fixed error:
  `invalid`, `not_found`, `limit` (a fifth image), or `conflict` (the store cannot be
  used, the task already holds that image ID, or, for an add or a remove, the task has
  started; see [A started task is read-only](#a-started-task-is-read-only)).
- The renderer reaches them through the fixed IPC channel `pomegr:task-image`
  (`desktop/runtime/task-image.mjs`), which posts to
  `POST /internal/tasks/image-add | image-remove | image-read`
  (`server/serving/task-image-routes.mjs`). `image-add` takes the bytes as the whole
  `application/octet-stream` body with the repository ID, the task ID, and optionally
  the image ID as its only query keys; the other two take the usual `{ repositoryId, payload }` envelope
  with exactly `{ taskId, imageId }`. `image-read` answers the bytes with one of the
  four fixed media types and `X-Content-Type-Options: nosniff`.
- The task text says where each image belongs. An image is the marker
  `[image:<imageId>]` at its place in the text: ordinary task text, counted in the
  4,000 characters, that names one of `Task.images`. The Task field of the desktop
  forms is rich text (`TaskRichText` in `app/components/tasks/TaskImages.tsx`): a
  `contenteditable="plaintext-only"` region whose value is still that one string. It
  draws each marker as the image, inline, and serializes an image back to its marker.
  Every other surface shows the plain word `[image]` (`plainTaskText`): cards, the
  Search bar, the session's Task tab, and the text sent to GitHub.
- The renderer makes the image ID (`newTaskImageId`, `img-<12 random hex>`) when an
  image is pasted, dropped, or attached, so the text can name the image before it is
  stored. `image-add` takes that ID as its optional third query key; the monitor
  validates its shape and answers `conflict` for one the task already holds. The file
  name is still built only from validated identifiers.
- An image is saved with the text that names it. In the New task form the images wait
  in renderer memory; once the task exists the form stores the ones its text names.
  When one fails, the task stays and its own modal opens with one fixed line. In the
  Task form an image is part of the Save draft: Save stores the new images the text
  names, then sends the text, then removes the stored images the saved text no longer
  names. An image that cannot be stored leaves the text unsaved. Close discards the
  draft and stores nothing. The Task form shows the text with every image the task
  holds: a marker that names no image of the task is not drawn, and an image the text
  does not name is shown at its end (`shownTaskText`), so no image is held unseen.
- The renderer draws an image from an object URL of its own page and revokes it when
  the modal closes; the desktop content security policy allows `blob:` for `img-src`
  only, for this.
- A session gets the images the task holds when it starts; see
  [Starting a session](#starting-a-session). In the prompt a marker reads as its
  image's number, `[Image #n]`, and the list of files names each image by the same
  number, so the agent knows which image the text means where. A marker that names no
  listed image reads `[image]`. A started task takes no new image, so the
  session has every image its task holds. A requeued task starts its next session with
  the images it holds then.
- Creating a GitHub issue from a task sends its text only, with `[image]` where the
  text holds a marker; no image and no image ID is sent. A promote makes a task
  with no image.
- The agent chat is the one other way an image reaches a task: an approved proposal
  stores an image that the owner sent to Aril, through the same `image-add` route and
  under the same rules ([Agent chat: An image on a task](agent-chat.md#an-image-on-a-task)).
- Not built: images on a card, an image from an agent tool (`add_task` is text only), and
  a per-repository total. The store's worst case is 500 tasks of four 5 MiB images.

## Paired devices

Decided by the product owner's request of 2026-10-10 (task T-30): a paired device, such
as a phone, reads the board and manages tasks. A paired device is a browser that redeemed
a pairing code made in the desktop app; the LAN gateway (`desktop/runtime/lan-gateway.mjs`)
serves no other client.

- **Read.** The gateway forwards `GET /api/tasks`, so the device gets the board a
  same-computer browser gets, and its `/api/sessions` directory reads get the task
  reference. The same path with `view=home` is the [Tasks home](#tasks-home), so the
  device gets that too.
- **Write.** One route, `POST /api/tasks/action`, with the body
  `{ repositoryId, action, payload }`. Three layers gate it, and each refuses on its own:
  1. The gateway takes the POST only with the session cookie, its own `Origin`, a JSON
     content type, no query, and a declared body of at most 17 KiB. It forwards the body
     with the desktop token and the `x-pomegr-lan-gateway` mark. Only the start and agent-chat POST paths described below are also accepted.
  2. The desktop web gate (`installLocalRequestGate` in `server/web/server.mjs`) lets
     through that one POST path, with the token and no `Origin`. Every other method and
     path stays read-only.
  3. The route (`app/api/tasks/action/route.ts`) refuses a request without the mark and
     the token with 403, so a same-computer browser, the development server, and its
     peers never write. A request that lacks the mark is refused, and a request that
     lacks the token is refused. It holds the closed list of fourteen `pomegr:task-action`
     names, the repository ID pattern, and the 16 KiB payload cap, and posts to
     `POST /internal/tasks/<action>` with the desktop token. The monitor validates the
     record as it does for the desktop app.
- **Answer.** `{ ok: true }`, with `taskId` after a `create`, or `{ ok: false, error }`
  with one of `invalid`, `not_found`, `limit`, `conflict`, `unsupported`, and
  `unavailable`. The board never crosses this route; the device reads it again through
  the GET.
- **Queue control.** The owner's request of 2026-10-12 lets a paired device turn the queue on, retry it, or turn it off.
  Selecting **On** consents to automatic starts by the desktop queue runner, as in the desktop app.
  The existing `queue_settings` action accepts the same settings and monitor validation as desktop IPC.
  The device may also set the threshold and schedule. Pomegr must remain open on the computer to start sessions.
- **Manual start.** The owner's request of 2026-10-12 adds `POST /api/tasks/start`. The desktop gateway handles it directly. It never forwards the request to the web host or exposes a start-plan proxy. Its exact JSON body is `{ repositoryId, taskId, confirmed: true }`, optionally with `worktree: true`. IDs use the existing repository and task patterns. Unknown keys, false flags, and missing confirmation are invalid. The route requires the pairing cookie, the gateway's own `Origin`, and JSON content type. It permits no query or transfer encoding. The declared body must be at most 512 bytes.
- **Start confirmation.** The phone's browser asks before every manual start and names the task ID and the computer running Pomegr. A separate-worktree confirmation explains that it excludes uncommitted changes. Cancellation sends no request. Desktop main uses the same starter and exclusive launch slot as native IPC and the queue runner. The same manual start gates apply, with no second confirmation on the PC. It revalidates pairing and network authorization before reserving a dispatch, after the plan returns, and immediately before launch. Lost authorization aborts a reserved dispatch. It never stops a session already launched.
- **Start answer.** The gateway returns only `{ status }` from the fixed `pomegr:task-start` status list, or a fixed HTTP refusal. It never returns a prompt, plan, path, dispatch token, process output, or exception. There is no automatic retry.
- **Assigned sessions.** The owner's decision of 2026-10-12 (task T-97) gives a paired
  device what the desktop app has: the board it reads carries `Task.assigned`, its
  Sessions list carries `assignedTasks`, and `session_assign` and `session_unassign`
  are in the route's closed list (see [Assigned sessions](#assigned-sessions)).
- **Images.** The owner's request of 2026-10-12 (task T-77) lets a phone attach an image.
  The gateway answers three routes itself with the device's cookie, and nothing of them reaches
  the web host: `POST /api/tasks/image-add?repositoryId&taskId&imageId` (an
  `application/octet-stream` body of at most 5 MiB, the gateway's own `Origin`, exactly those
  three query keys), `POST /api/tasks/image-remove` (JSON `{ repositoryId, taskId, imageId }`,
  at most 512 bytes, no query), and `GET /api/tasks/image-read` (the same three query keys).
  Each hands the validated values to the same `createTaskImage` action as the desktop IPC
  (`runPaired`, which skips only the trusted-window check, because the gateway has already
  authenticated the device), so the monitor's image rules, bounds, and fixed errors apply
  unchanged. An answer is `{ ok: true }`, `{ ok: true, imageId }`, `{ ok: false, error }` with
  one of the fixed image errors, or the bytes with one of the four media types, `no-store`.
- **Desktop only.** Open folder and GitHub issues have no forwarded route. A phone shows and
  edits images as the same inline marker as the desktop form.
- **Agent chat.** A paired device also reaches the agent chat, through one route that
  the gateway answers itself. [Agent chat](agent-chat.md#boundaries) owns it. A session
  start that Aril proposed is applied only in the desktop app: the chat route refuses it
  from a paired device, which keeps its own **Manual start** above. A queue change that
  Aril proposed can be applied on a paired device (task T-75, 2026-10-12): desktop main
  then sends `queue_settings` with `{ on }`, the action of **Queue control** above, so
  the chat route gives the device no queue authority it did not have.
- **Client.** `useTaskEditAvailability` in `app/components/tasks/task-desktop.ts` answers
  `desktop`, `paired`, `absent`, or `pending` until the client knows which, so no control
  or note is drawn and then taken back. `sendTaskAction` uses the bridge when there is
  one and the route only when `/api/client-access` answered `lan`. The start action follows the same availability and confirms on the paired device before posting to its direct start route.
- **Residual risk.** The gateway serves plain HTTP on the local network, so task content
  and the session cookie cross it unencrypted, as session content already does. Whoever
  holds a paired device's cookie can change the board, request a manual start, turn the queue on, and queue work.
  The confirmation is an owner-facing UI boundary, not proof against a holder of the cookie. Pairing, its four-device bound, the network checks, and revocation are unchanged.
  The product owner accepts this risk as part of phone access.
- **Revocation.** Revoking phone access ends the device's reads and writes at once.

## Boundaries

| Surface | Who | What it carries |
| --- | --- | --- |
| `GET /api/tasks?repositoryId=repo-<24 hex>` | A same-computer client or a paired device, gated like `GET /api/provider-folders`; the LAN gateway forwards it only for a paired device | The committed board, `no-store`, with each linked and each assigned session's borrowed title, state, and model, and a waiting task's per-condition reading. A denied client gets `readiness: "desktop_only"` and no task content |
| `GET /api/tasks?view=home` | The same clients, under the same gate and the same forwarding | The [Tasks home](#tasks-home), `no-store`: for each stored board its five column counts, its count of open features, its queue status with the blocking task's ID and the fixed pause reason, and the time of its newest task change; and for at most 50 tasks that wait for the owner, the repository ID, the task ID, the state, and one title line. A denied client gets `readiness: "desktop_only"` and no content |
| `GET /api/sessions?mode=directory` with the proxy's `tasks=1` marker | A same-computer client or a paired device; the LAN gateway marks the requests it forwards, and a marked request gets the marker only with the desktop token the gateway adds | Each row's nullable `task` (task ID, board repository ID, outcome state or null, feature ID, feature name, and the nullable number of the GitHub issue the task was promoted from, never an issue title or body), on a session that is assigned to a task `assignedTasks` (the same reference for each such task), the `feature` scope, `group=feature`, and the `session` scope (one validated session ID, no other scope beside it) that the session view uses to read its own row. Without the marker: `taskReadiness: "desktop_only"`, no `task` key, and a feature scope matches no session |
| `pomegr:task-action` IPC | The renderer, through a trusted main frame only | A fixed action name, the repository ID pattern, and a payload of at most 16 KiB |
| `POST /api/tasks/action` | A paired device, through the LAN gateway only (see [Paired devices](#paired-devices)) | `{ repositoryId, action, payload }` with the same fixed action names and bounds, including queue on and off; answers `{ ok: true }` (with the new task's ID after `create`) or one fixed error, never the board |
| `POST /internal/tasks/<action>` | Desktop main, with the desktop token | The same action; the monitor validates the whole record. The answer to `create` also carries the new task's ID, so the modal can name the task when it asks for a GitHub issue |
| `pomegr:task-start` IPC | The renderer, through a trusted main frame only, behind a native confirmation | A repository ID and a task ID, and for a separate-worktree start the fixed value `true`; answers one fixed status. The agent chat's applied start proposal reaches the same starter in desktop main, with the event of its own trusted `pomegr:agent-chat` call; its confirmation is **Start session** on the proposal card, not the native one |
| `POST /api/tasks/start` | A paired device through the desktop LAN gateway, behind confirmation on that device and repeated authorization checks | `{ repositoryId, taskId, confirmed: true, worktree?: true }`, at most 512 bytes; answers only `{ status }` from the IPC start allowlist; never forwards or exposes a start plan |
| `pomegr:task-worktree-open` IPC | The renderer, through a trusted main frame only (the task modal's and the Queue banner's **Open folder**) | A repository ID and a task ID; answers one fixed status (`opened`, `not_found`, `invalid`, `unavailable`). Desktop main resolves and opens the worktree folder; the path never leaves it |
| `POST /internal/tasks/start-plan` and `start-abort` | Desktop main, with the desktop token; not reachable through `pomegr:task-action` | The start plan with the repository root, prompt, image files, and dispatch token; none of them reaches the renderer or `GET /api/tasks` |
| `POST /internal/tasks/queue-next` and `queue-pause` | The desktop queue runner, with the desktop token; not reachable through `pomegr:task-action` | At most 16 `{ repositoryId, taskId }` next starts, and a fixed pause reason in; no task content either way |
| `POST /internal/tasks/worktree-cleanups`, `worktree-root`, and `worktree-cleaned` | Desktop main and its queue runner, with the desktop token; not reachable through `pomegr:task-action` | `worktree-cleanups`: at most 64 `{ repositoryId, taskId, repositoryRoot }` done tasks whose worktree waits for removal. `worktree-root`: the root of one repository, or `not_found`. `worktree-cleaned`: a task ID in. The root reaches desktop main only, as in the start plan; no task content either way |
| `pomegr:task-issues` IPC | The renderer, through a trusted main frame only | One of the fixed operations `status`, `list`, `promote`, `create`, `sign_in`, a repository ID, for `promote` only an issue number (1 to 999999999) and a 64-character hexadecimal digest, and for `create` only a task ID. The payload cap is the 16 KiB cap of `pomegr:task-action`. `status`, `list`, `promote`, and `create` return the monitor's answer; `sign_in` returns one fixed status after a native confirmation |
| `POST /internal/tasks/github-status`, `issues-list`, `issue-promote`, and `issue-create` | Desktop main, with the desktop token; not reachable through `pomegr:task-action` | `github-status`: the fixed connection and, when connected and the repository root is recognized, its visibility and capabilities. `issues-list`: reads GitHub now and answers a fixed read status, the read time, a truncation flag, and the normalized issues with each one's promoted task ID or null; the only place issue text is served. `issue-promote`: `{ number, digest }` in, `{ ok: true, taskId }` out. `issue-create`: `{ taskId }` in, `{ ok: true, number }` or one fixed error out; the only write to GitHub, and its answer never carries task text |
| `pomegr:task-image` IPC | The renderer, through a trusted main frame only | One of the fixed operations `add`, `remove`, `read`, a repository ID, a task ID, an image ID, and for `add` only the image bytes (a `Uint8Array` of at most 5 MiB). Answers `{ ok: true, imageId }`, `{ ok: true }`, `{ ok: true, type, bytes }`, or one fixed error |
| `POST /internal/tasks/image-add`, `image-remove`, and `image-read` | Desktop main, with the desktop token; not reachable through `pomegr:task-action` | `image-add`: the bytes as the body and the IDs in the query; answers the image's ID. `image-remove`: `{ taskId, imageId }`. `image-read`: the same in, the bytes with a fixed media type out; the only place image bytes are served. No answer carries a path |
| `POST /api/agent/v1/tasks/add\|complete\|block` | An agent through the MCP tools, authorized like the agent-query GETs | `complete` and `block` carry the bound session, optionally one task ID of that session, and, for a block, the reason; they answer the resulting state and each condition's result: passed, failed, or unavailable |
| `POST /api/agent/v1/tasks/assign\|unassign` | An agent through the MCP tools `assign_task` and `unassign_task`, authorized like the agent-query GETs | The bound session and one task ID in; `ok` or one fixed reason out. Never task content, a state, or another session |
| `POST /api/agent/v1/tasks/remove` | An agent through the MCP tool `remove_task`, authorized like the agent-query GETs | The bound session and one task ID in; `ok` or one fixed reason out, with `not_found` for every task the session may not remove. Never task content, a state, or who added a task |
| `POST /api/agent/v1/tasks/update` | An agent through the MCP tool `update_task`, authorized like the agent-query GETs | The bound session, one task ID, and the task fields the agent supplied in (text, Run on, effort, Complete when, and the task IDs it runs after); `ok` or one fixed reason out, with `not_found` for a task that does not exist and for one that started. Never task content, a state, or a list |
| `POST /api/agent/v1/tasks/get\|list` | An agent through the MCP tools `get_task` and `list_tasks`, authorized like the agent-query GETs | The bound session and one task ID, or up to four list filters, in; one served task, or at most 100 with each text cut at 300 characters, out, or one fixed reason. A served task is its ID, text, own condition, checks, Run on, effort, feature title, column name, state, `editable`, and the task IDs it runs after. Never a report, a session, an image, who added a task, or an internal ID |
| `POST /api/agent/v1/tasks/feature-get` | An agent through the MCP tool `get_feature`, authorized like the agent-query GETs | The bound session and optionally one feature ID or title, or one task ID of that session, in; that feature's ID, title, description, and app version out, or one fixed reason. With `get` and `list`, one of the three agent paths that answer user-authored board content |
| `POST /api/agent/v1/tasks/feature-create\|feature-update\|feature-delete` | An agent through the MCP tools `create_feature`, `update_feature`, and `delete_feature`, authorized like the agent-query GETs | The bound session and the feature fields the agent supplied in; the feature's ID, or nothing for a delete, or one fixed reason out. Never feature content |
| `POST /api/agent/v1/tasks/bind` | The plugin's session-start hook, authorized like the agent-query GETs | The dispatch token and the normalized session ID; answers a fixed object with no task data. Not an MCP tool; no other path may be added without updating the [Privacy](#privacy) section first |

- The fixed IPC actions are `create`, `update`, `delete`, `move`, `feature_create`, `feature_update`, `feature_delete`, `queue_add`,
  `queue_remove`, `queue_group`, `queue_ungroup`, `queue_settings`, `resolve_done`,
  `resolve_requeue`, `session_assign`, `session_unassign`, and `after_set`. Any other action name is refused: `invalid` from the preload, desktop
  main, and the route, and `unsupported` from the store itself. That includes the removed
  `column_create`, `column_rename`, `column_reorder`, `column_delete`, `column_role`, and
  `queue_reorder`. Built so far: `create` with `{ text, run?, completeWhen? }`, `update` with
  `{ id, text?, run?, completeWhen? }`, and `delete` with `{ id }`; a payload with any other
  key is `invalid`. In `update` at least one of the three fields is required, a field
  that is present replaces the stored one whole (a null `run` or `completeWhen` clears it),
  and an absent field is left as stored. An `update` of a task that has started answers
  `conflict` (see [A started task is read-only](#a-started-task-is-read-only)). `move` takes `{ id, columnId, position, group? }`:
  `position` is the zero-based index in the destination column counted after the task
  leaves its place, and a value past the end appends. A
  `columnId` that is not one of the board's five columns answers `not_found`, and a card
  that waits in the queue sent to another column than Ready answers `conflict`. Task
  positions stay dense after every action. `group` is `"block"` or `"leave"`, and any
  other value is `invalid`. With `"block"`, a card in a parallel group moves with the
  cards of its group that have not started, in board order, to `position` counted after
  the block leaves; a card in no group moves alone, and a block with a waiting card sent
  out of Ready is `conflict`. With `"leave"`, a grouped card leaves its group and lands at
  `position`. Without `group`, a grouped card that lands away from every other card of its
  group that has not started leaves the group, and one that lands beside a sibling stays in
  it (a reorder inside the group). Only a card that has not started has a group in a move.
  `feature_create` takes `{ name, description?, appVersion? }` (the name is one line of 1
  to 80 characters, the description at most 2000, the app version one line of at most 40;
  an absent or blank one is none); a
  duplicate name in the repository answers `conflict` and a 51st feature `limit`.
  `feature_update` takes `{ id, name?, description?, appVersion?, done? }` with at least one
  field beside `id`: a present field replaces the stored one, an absent one stays, and a
  null `description` or `appVersion` clears it. `done` is a boolean: `true` marks the
  feature done and `false` reopens it; any other value is `invalid`. An unknown `id` answers `not_found`, a
  name another feature holds `conflict`, and the feature's own name is no conflict.
  Neither answers the description or the app version. A
  feature is listed with the `done` the owner stored, `false` until marked. `create` and `update` take one
  optional key, `featureId` (a feature ID or null). A payload with a `step` is `invalid`:
  no step exists. An unknown feature, or one of another
  repository, is `not_found`; a done feature (the owner marked it done) refuses a
  task that is not already in it with `conflict`. In `update`, `featureId: null`
  detaches, and the task's own feature ID changes nothing. A feature has no order, so a
  task that joins or leaves a feature moves no card and changes no group.
  `feature_delete` takes `{ id }`, answers `not_found`
  for an unknown feature or one of another repository and `conflict` while a task of the
  feature has started and is not done, and otherwise detaches the feature's tasks and
  deletes it (see [Feature context](#feature-context)). The desktop actions have no
  feature reorder.
  `queue_add` takes `{ id }`, `{ id, group: "block" }`, or `{ id, at }`. With
  `group: "block"`, every card of the task's group that has not started and is not queued
  becomes `queued`, and the group's cards take the end of Ready in the order they had; a
  task in no such group is `conflict` (see [Planning before Ready](#planning-before-ready)).
  `at` is an instant written as
  `2026-10-09T02:00:00.000Z`. Without `at`, a task in state `not_queued` becomes `queued`
  with its card in Ready (last when it comes from another column), and a `scheduled` task becomes `queued` in the place it has and
  loses its time; any other state is `conflict`. With `at`, a task in state `not_queued`,
  `queued`, or `scheduled` with no linked session becomes `scheduled` with that time, in
  the place its card has in Ready or at the end of it; a task with a session or an outcome is `conflict`, and a
  time outside the bounds is `invalid`. An unknown task is `not_found`. `queue_remove`
  takes exactly `{ id }`: a `queued` or `scheduled` task with no linked session becomes
  `not_queued`, loses its time, and leaves its parallel group; any other state, or a linked session, is `conflict`. `resolve_requeue` clears the time and the group too.
  `queue_group` takes exactly `{ ids }`: 2 to 16 distinct task IDs, otherwise `invalid`.
  Each must exist (`not_found`) and have not started: a waiting card (state `queued` or
  `scheduled`) or a planned card (state `not_queued`, card in Backlog or Ready), with no
  linked session and no live dispatch (otherwise `conflict`). The cards join the group
  of the first listed card that is in one, or a new group when none is, and land right
  after the last card of that group in its column: Ready when a member is in the queue,
  otherwise the first listed card's column. A group that gives every waiting
  card away this way sends its members that already started along, so they stay in one
  turn with those cards. A group that would hold more than 16 members
  answers `limit`. Repeating the action changes nothing and answers ok.
  `queue_ungroup` takes exactly `{ ids }`: 1 to 16 distinct task IDs, otherwise `invalid`.
  Each listed task leaves its group. It keeps its place, or lands right after the group
  when it stood between two cards that stay in it. A task in no group changes
  nothing and answers ok, an unknown task is `not_found`, and a grouped member that
  already started answers `conflict`, which writes nothing.
  `after_set` takes exactly `{ id, after }`: `after` lists 0 to 8 distinct task IDs, never
  the task itself, otherwise `invalid`. An unknown task, listed or not, is `not_found`. A
  task that has started is `conflict`, and so is a list that would make tasks wait for each
  other. The list replaces the stored one, and an empty list clears it (see
  [Runs after](#runs-after)). It starts and stops nothing. The four queue actions start
  no session and leave the stored queue status as it is,
  except `queue_remove` of the task a pause names, which ends that pause (see
  [Queue](#queue)). `resolve_done` and
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
- A browser that is not a paired device never mutates tasks or starts a session. A paired device may request only the confirmed manual start described in [Paired devices](#paired-devices); the desktop performs the launch.
- The seven MCP observation tools stay read-only, as in [MCP observation queries](mcp-queries.md).
  The task tools are a separate registration with the fourteen POST paths above (`bind`
  is the hook's, not a tool's): eleven writes and three reads, `get`, `list`, and
  `feature-get`.

## Privacy

- Superseded report history stays only in the task store, under the bounded retention in [Completion](#completion).
- History never enters an API, IPC, agent tool answer, browser, session domain, catalog, checkpoint, report, log, notification, or diagnostics.
- Completion answers may carry `state: "blocked"` with fixed per-condition results when an owner hold remains.
- That answer carries no prior report, block reason, attention line, session identity, or repository fact.

- A paired device may send queue on and off through the existing authenticated task action route. Only the desktop queue runner launches sessions.
- A paired device may also apply a queue proposal of the agent chat. Desktop main then sends the same `queue_settings` action with `{ on }` and nothing else, and the chat keeps only the state asked for and one fixed result.
- A paired manual start sends only the repository ID, task ID, confirmation flag, and optional separate-worktree flag to the desktop gateway. Its answer exposes only a fixed start status. The private plan, prompt, filesystem paths, image files, credentials, and dispatch token stay on the desktop's existing private launch path.

Task text, the own condition, and a feature's name, description, and app version are
user-authored content, a new data class. A description or an app version that an agent
wrote with `create_feature` or `update_feature` is the same class. Column names are five
fixed values.

- Issue titles and bodies are third-party content, text written by other people. They are
  served only by `POST /internal/tasks/issues-list` to desktop main and from there to the
  trusted renderer. They never enter `GET /api/tasks`, `/api/state`, a session domain, a
  catalog, a checkpoint, a report, a log, a notification, or diagnostics, and browser and
  LAN clients never receive them. Once promoted, the copied text is ordinary task text
  and follows the rules below. `GET /api/tasks` gains only `Task.source`. The Sessions
  list's task reference carries the same issue number as one nullable field (below); those
  two places serve the number, and neither serves issue text.
- Creating a GitHub issue sends a task's text outside the computer, to GitHub, once and
  only on the owner's explicit desktop action. Anyone who can see the repository can then
  read it. This is the one place user-authored task content leaves Pomegr. The request
  carries a repository ID and a task ID; the answer carries the issue number or one fixed
  error, never the text, a title, a URL, or a `gh` message. The fixed errors are
  `invalid`, `not_found`, `conflict`, `cli_missing`, `not_signed_in`, `no_access`,
  `issues_disabled`, `failed`, and `unavailable`.
- Nothing from an issue is interpolated into a command line or a path.

- They live only in the task store, and are served only by `GET /api/tasks` (to a
  same-computer client or a paired device) and the desktop IPC.
- The Tasks home (`GET /api/tasks?view=home`, task T-54, 2026-10-11) is that same read
  under that same gate, so it reaches no new client. It serves less than a board: of
  user-authored content, only one title line for each of at most 50 tasks that need
  review, are stalled, or are blocked. The line is the bound session's title, or the
  first line of the task text, cut at 160 characters. No own condition, block reason,
  attention line, feature name, image, model, or session ID enters it.
- A feature's description and app version live only in the task store and are served
  only by `POST /api/agent/v1/tasks/feature-get`, to an agent whose session is bound to
  that board (task T-33, 2026-10-10). This is a deliberate widening: an agent could
  write task content before, and with `get_feature` it also reads feature content, so
  the feature's title, description, and app version reach the provider through that
  session, as a task's text does through its prompt.
  - `GET /api/tasks` serves a feature as `{ id, name, done }` only. The description and
    the app version never enter it, the Sessions list's task reference, `/api/state`, a
    session domain, a catalog, a checkpoint, a report, a log, a notification, or
    diagnostics.
  - The session prompt carries the feature's title and opaque ID, never the other two
    fields.
  - The desktop Feature modal (task T-70) reads them through `pomegr:task-feature` and
    `POST /internal/tasks/feature-read`, and writes them through `feature_create` and
    `feature_update`. Only the trusted renderer of the desktop app receives them, in
    memory while the modal shows them. `feature_update` and `feature_delete` are not in
    the paired-device route, and that route refuses a `feature_create` with any key beside
    `name`, so a paired device can neither read nor write them, and no Next route proxies
    the read.
  - The answers of `feature_create`, `feature_update`, and `feature_delete` carry the board, which lists a
    feature as `{ id, name, done }`, and never the description or the app version. The
    read route's answer is bounded again on the way out, and carries no error text.
  - The answers of `feature-create`, `feature-update`, and `feature-delete` carry the
    opaque feature ID or nothing, and one fixed reason on refusal. `not_found` is the
    same for a feature that does not exist and one of another repository's board.
  - `get_feature` reads a feature of the session's own board only. The board is chosen
    by the session binding, never by an input.
- Which sessions are assigned to a task is a list of normalized session IDs, the same
  class as the linked session's ID (task T-97, 2026-10-12). This is a deliberate
  widening of what the board and the Sessions list serve.
  - The task store keeps the IDs beside the task, and nothing else of a session.
  - `GET /api/tasks` serves them as `Task.assigned`, each with the borrowed title,
    state, and observed model that `Task.session` already carries, under that route's
    gate, to a same-computer client or a paired device. The facts are borrowed per read
    and never stored.
  - The Sessions list serves a session's assigned tasks as `assignedTasks`: the task
    reference it already serves as `task`, with the same fields and the same gate, and
    never task text, an own condition, a report, a block reason, or an attention line.
  - The agent paths `assign` and `unassign` answer `ok` or one fixed reason. No agent
    path returns who is assigned to a task, and `get_feature` with a task ID reads only
    a task of the calling session.
  - The owner's assign control reads the repository's sessions from the Sessions
    directory the client may already read; the task routes serve no session list.
  - Assignments never enter `/api/state`, a session domain, a catalog, a checkpoint, a
    report, a log, a notification, or diagnostics, and no pipeline stage reads them.
- Which session added a task is monitor-private. The task store keeps the normalized
  session ID of an `add_task` call beside the task, and only the rule of
  [Agent task removal](#agent-task-removal) reads it. It is on no board, route, list,
  log, report, or checkpoint, and `remove_task` answers the same `not_found` for a task
  the session did not add as for one that does not exist. It never appears on
  `GET /api/tasks`, the Sessions list's task reference, `/api/state`, a session domain,
  a catalog, a notification, or diagnostics.
- `update_task` sends task fields to the local monitor and gets none back. Its answer is
  `ok` or one fixed reason (see [Agent task update](#agent-task-update)). The fields it
  writes are the ones the desktop `update` action writes, kept and served as that
  action's are.
- A task's text, own condition, checks, Run on, effort, feature title, column name,
  state, and the task IDs it runs after (added by task T-111) are served to an agent only by `POST /api/agent/v1/tasks/get` and `list`, to an
  agent whose session is bound to that board (task T-118, 2026-10-15). This is a
  deliberate widening: before it, no agent path returned a task's text. With `get_task`
  and `list_tasks`, the fields of any task of the board reach the provider through the
  calling session, as a task's text does through its prompt.
  - The answers carry only the fields that [Agent task read](#agent-task-read) lists.
    They never carry a report, an attention line, a block reason, a session, an image
    or its ID, who added the task, a path, a token, or a repository, column, or feature
    ID. Each field is bounded again on the way out.
  - A list carries at most 100 tasks, each text cut at 300 characters.
  - `not_found` is the same for a task that does not exist and one of another board.
  - The search query of `list_tasks` lives in memory for the request only. It is on no
    board, route answer, log, report, or checkpoint.
  - The reads never enter `/api/state`, a session domain, a catalog, a checkpoint, a
    report, a log, a notification, or diagnostics.
- What makes `add_task` safe to repeat is memory only: a digest that covers the task
  text, never the text, held in the monitor for five minutes (see
  [Session binding](#session-binding)). It is on no board, route, list, log, report,
  checkpoint, or disk.
- A task's images are the same data class. `GET /api/tasks` carries only each image's
  opaque ID, fixed type, and size. The bytes cross only the `pomegr:task-image` channel
  and its three desktop-token routes, to and from the trusted renderer; no GET serves
  them and a browser or LAN client never holds one. The renderer keeps them in memory
  only while a modal shows them, never in browser storage. A started session is given
  the files of its task's images, so the images and the path of the private folder
  that holds them reach the provider through that session, as the task text does.
  Nothing else reads the files: no pipeline stage, report, log, or notification.
  - `Task.images` never carries dimensions or anything read from inside an image.
  - The answers of the three routes carry only the image's ID, the bytes with one of
    four fixed media types, or one fixed error. The fixed errors are `invalid`,
    `not_found`, `limit`, `conflict`, and `unavailable`. No answer carries error text.
  - A browser or LAN client never sends image bytes. Agents get no image tool. The agent
    chat sends the bytes of an image the owner gave it, from desktop main, for an
    approved proposal only ([Agent chat: Privacy](agent-chat.md#privacy)).
  - Images never enter `/api/state`, a session domain, the Sessions list's task
    reference, a catalog, a checkpoint, a report, a log, a notification, or diagnostics.
- The Search bar (the Ctrl K palette) searches the tasks of the board in view. This is a
  presentation of the board the client already holds, not a new read or route:
  `TaskBoardPane` registers the ready board's tasks as the palette's scope
  (`app/components/command-center/palette-scope.ts`, items built by
  `app/components/tasks/task-search.ts`) and withdraws them when the board leaves the
  page or stops being ready, so a `desktop_only` client has nothing to search. The items
  and the query stay in renderer memory: never in browser storage, a URL, a request, or
  the notification layer. A match is by task ID, task text, session title, feature name,
  column name, chip label, and `#<issue number>`. Choosing a task opens its Task modal
  in the desktop app; any other client is shown the card on the Board, with a feature
  filter cleared. No other page puts task text in the palette.
- A column's role is not user-authored text: it is one of three fixed values or null,
  served on `GET /api/tasks` beside the fixed column name and nowhere else.
- A task's parallel group is an opaque value the board serves (task T-94, 2026-10-13).
  `Task.group` is `grp-<12 hex>` or null. The store makes it, and it is derived from no
  task text, session, path, or time. It is served on `GET /api/tasks`, under that route's
  gate, to a same-computer client or a paired device. It never enters the Sessions list's
  task reference, `/api/state`, a session domain, a catalog, a checkpoint, a report, a log,
  a notification, or diagnostics. The `queue_group`, `queue_ungroup`, and `move` payloads
  carry task IDs and the fixed words `block` and `leave`, and their answers carry no group
  ID. The start gate block names the earlier task by its task ID only
  (`queue.gates.next.blockedBy`), as it did before; no gate reason, answer, or other
  field names a group. The `queue-next` answer holds task IDs and carries no group.
- What a task runs after is a list of task IDs of the same board (task T-101,
  2026-10-14), set by the owner and stored in the task store's `meta`. It is served as
  `Task.after` on `GET /api/tasks`, under that route's gate, to a same-computer client or a
  paired device, and in the `runs_after` reason of `queue.waits`. The `after_set` payload
  carries task IDs only, from the desktop app or a paired device, and its answer is the
  board. The agent chat reads it in its board snapshot as `runs_after` and proposes it as
  `set_after` (see [Agent chat](agent-chat.md#privacy)). An agent sets it with the
  `runs_after` input of `add_task` and `update_task` (task T-111, 2026-10-15): task IDs
  only, sent from the bound session to the local monitor for a task of that session's
  board that has not started. Their answer carries no list, only `ok` or one fixed
  reason. `get_task` and `list_tasks` read the list back as `runsAfter`, to an agent bound
  to that board, so it can set the whole list (a deliberate widening, decided by the
  owner on 2026-10-15). It never enters `/api/state`, the Sessions list's task reference,
  a session domain, a catalog, a checkpoint, a report, a log, a notification,
  diagnostics, another MCP tool's answer, or a session's prompt.
- A planned group (task T-101) is the same opaque `Task.group` as above, served the same
  way. Planning stores no other value: the plan's order is the card order the board
  already serves.
- They never enter `/api/state`, session catalogs, reports, logs, notifications,
  diagnostics, pipeline-operations logs, or observation checkpoints, and no pipeline
  stage reads them.
- The agent chat reads the board for desktop main and puts task text, own conditions,
  feature titles, block reasons, and attention lines in the prompt of its provider run.
  That is a deliberate widening (task T-29, 2026-10-11), owned by
  [Agent chat: Privacy](agent-chat.md#privacy). The chat changes the board only through
  the fixed task actions, after the owner applies a proposal. Of a session start it
  applied, the chat keeps the task ID and one fixed start status, and nothing of the
  start plan. Of a queue change it applied, the chat keeps the state asked for and one
  fixed result, and nothing of the board.
- The Sessions list and session view receive only the task ID, task state, feature name,
  and the number of the GitHub issue the task was promoted from. That is a
  deliberate widening of exposure (the issue number was added on 2026-10-09): the part
  that builds it updates this section in the same pull request, and it must not
  carry task text, the own condition, a column name, or an issue title or body. It
  also never carries a report, a block reason, or an attention line. The reference is
  never written to the session catalog, a checkpoint, or the shell feed.
- The Sessions list part has shipped. `server/tasks/task-session-link.mjs` reads the
  reference, and `server/serving/session-directory-tasks.mjs` joins it onto a directory
  page when the page is served. It adds the ID of the repository whose board holds the
  task, so the task ID can link to that board (the session's own committed repository ID
  can be missing or another one), and the opaque feature ID, which the Feature filter passes back and a
  session's feature link puts in the board address (task T-93, 2026-10-12; see below). The
  state is served only as `needs_review`, `stalled`, `blocked`, `done`, or null; the list
  draws a chip for Needs review, Stalled, and Done, and none for Blocked by agent. It also
  carries the nullable issue number (1 to 999999999) that `readTaskSource` in
  `server/tasks/task-source.mjs` reads from the task store's `meta` row; a missing,
  malformed, or out-of-range row is served as null.
- The session view part has shipped with no new projection. The session view asks the same
  directory read for its own row (`session=<normalized session ID>`), so it gets the same
  reference, the same gate, and nothing on `/api/state` or a session domain. The scope is a
  session ID, not task data: it narrows the page for every client, and a client without
  the marker still gets no `task` key. The header and the Task tab
  then read the task itself from `GET /api/tasks` for the reference's repository
  (`app/session-task-store.ts`, `app/components/dashboard/SessionTaskMeta.tsx`,
  `SessionTaskTab.tsx`). While that board is not ready they show only the reference's ID,
  state, and feature; the Source line comes from `Task.source` on a ready board, not
  from the reference. The Task tab is listed only once the reference is known, so it
  is never shown and then removed; it mutates nothing.
- A session's feature link is `/tasks?repository=<repositoryId>&feature=<featureId>`
  (`sessionFeatureHref` in `app/components/tasks/SessionTaskCell.tsx`). The address carries
  only the two opaque IDs the reference already holds, never a feature name. The Tasks page
  validates both (`featureRouteId` in `app/components/tasks/task-features.ts`) and sends
  neither to a new route: the board is the same `GET /api/tasks` read under the same gate.
  - The desktop app opens the Feature modal, which reads the description and the app
    version through `pomegr:task-feature` as it does from **Edit feature**.
  - A paired device and a same-computer browser only choose the feature in the filter, from
    the `{ id, name, done }` the board already serves them. They make no feature read, so
    the description and the app version still never reach them.
  - A feature ID the ready board does not hold opens nothing and reads nothing. The page
    does not say whether the feature was deleted or belongs to another board.
- A session's task reference is found by the session link, and its assigned tasks by
  the assignment rows, never by repository ID. The
  session catalog stores none of it: the catalog index only takes a bounded set of
  session IDs to narrow or group a page.
- Grouping by feature lists only sessions started for a task that belongs to a feature,
  from at most the 2000 newest links. A session with no task, or with a task outside a
  feature, is in no group. An assigned session is not started for the task, so the
  feature scope and the feature groups do not list it.
- Task references follow the `GET /api/tasks` gate. The LAN gateway forwards
  `/api/sessions` with a loopback host, so it marks every forwarded request with
  `x-pomegr-lan-gateway`, and the same-origin proxy sets `tasks=1` on a marked
  request only when it also carries the desktop token, which the gateway alone adds
  and only for a paired device (`isPairedGatewayRequest` in `app/api/paired-gateway.ts`).
  The development server marks a peer that is not local the same way, because
  it listens on the LAN and a peer can send any Host header; that peer has no token and
  never gets the marker. A client without the marker gets `taskReadiness: "desktop_only"`: the list
  has no Task column, and Group by Feature says where features are shown.
  - The same-origin proxy sets the `tasks=1` marker itself. It never copies the marker
    from the request.
  - The monitor also requires its same-computer read gate.
  - A client without the marker gets no `task` key and no feature name.
  - A feature scope that cannot be answered matches no session. It never matches every
    session.
- Task state shown beside a session is a projection of the task store, never an
  observation of the session.
- The session view's Events feed lists the agent's own `add_task`, `remove_task`,
  `complete_task`, and `block_task` calls (task T-57, 2026-10-11). That is the reverse
  case: an observation of the session's recorded tool calls, never a projection of the
  task store. No observation module reads the store for it, and the store is not told.
  Each event carries a fixed kind, the agent, and the recorded time. It never carries a
  task ID, task text, a feature, a block reason, or an attention line, so no value of the
  task data class enters a session domain, a checkpoint, or the session-event sidecar.
  The rules and limits are in [Session events](metrics.md#session-events) and
  [Session evidence](privacy/session-evidence.md#session-events).
- Provider and model names, effort, check results, and times are normalized enums or
  identifiers, not user content.
- The pull-request check status is monitor-private. It is held only in memory, as one
  fixed `passed`, `failed`, `pending`, or `none` value together with the time of the read
  that established it, for at most 256 pull-request URLs, and it is not part of the
  normalized pull-request item. It is never persisted and never enters `/api/state`, a
  session domain, a repository snapshot, a report, a log, or `GET /api/tasks`. Its only
  use is the CI passed condition, which exposes passed, failed, or unavailable, and the time
  only refuses a result on a fact read before the session's latest relevant work. Check names, URLs,
  conclusions, and counts are dropped when the list is normalized.
- The committed repository and pull-request blocks of a live session state also carry a
  monitor-private `readAt` (the start of the Git read, and the start of the oldest
  pull-request read). The session-state serializer removes them before any serving, and
  they never appear on `/api/state`, a session domain, a repository snapshot or sidecar, a
  checkpoint, a report, a log, or `GET /api/tasks`. The ownership note is in the
  [observation cache](observation-cache.md).
- The attention line is agent-authored text. `GET /api/tasks` serves it only as the
  nullable `report.attention`, under that route's gate. It never enters the report's
  answer, `/api/state`, a session domain, the Sessions list's task reference, a
  catalog, a checkpoint, a log, a notification, or diagnostics.
- The Remote Control flag is one boolean (task T-31, 2026-10-10).
  - `GET /api/tasks` serves it only as `Task.run.remoteControl`, under that route's
    gate.
  - It never enters `/api/state`, a session domain, the Sessions list's task reference,
    a catalog, a checkpoint, a report, a log, a notification, or diagnostics.
  - Desktop main passes only the fixed argument `--remote-control`. It passes no name,
    URL, or other value, and nothing from task text reaches that argument.
  - The started session registers itself with the owner's Claude account. The session,
    with the task text in its prompt, is then reachable from the owner's other devices,
    as any Remote Control session is.
- Why a task waits is a reading of the board (task T-73, 2026-10-13). This is a
  deliberate widening of what `GET /api/tasks` serves, under that route's gate, to a
  same-computer client or a paired device.
  - `queue.waits` carries, for a waiting task, its ID, its place in the start order as a
    whole number or null, and fixed reasons from one list. A reason names at most eight
    task IDs of the same board and a count of the rest.
  - `running_work` is the one new fact: which tasks have started and hold the queue. A
    board already shows a linked task's session; a task whose start has not linked yet
    is now named as running too, by its ID only. The dispatch token and its time never
    leave the store.
  - It never carries task text, a feature name, a session ID, a path, a usage
    percentage, a reset time, an incident name, a changed file, or error text.
  - It never enters `/api/state`, a session domain, the Sessions list's task reference,
    the Tasks home, the agent chat's prompt, a catalog, a checkpoint, a report, a log, a
    notification, or diagnostics. It is never stored.
- `runModels` never carries entitlement, a hidden ID, an alias ID, or a raw catalog row.
- A worktree path stays in desktop main. It never enters the monitor, the task store,
  browser state, a log, or a report. It is built there from the repository root the
  monitor answers to desktop main and the task ID. The monitor reads the same path shape
  only from a session's own working directory, to name the repository of a removed
  worktree (see [Repository context inventory](observation-cache.md#repository-context-inventory)).

## Invariants and failure behavior

- Observation is unchanged and independent. If the task store, a route, or the dispatcher
  fails, observation, serving, and notifications continue, and the Tasks page reports
  `unavailable`. If observation is unavailable, the board still reads, but borrowed
  session state is unknown rather than guessed.
- A mutation that fails validation changes nothing and returns a fixed error.
- A failed GitHub issue create never changes, blocks, or undoes a task. The store is
  written only after GitHub answered with an issue number. Nothing is retried by itself.
  If the deadline passes before GitHub answers, the create reads as `failed` although
  GitHub may have made the issue; asking again would then make a second one.
- Preserve the last known-good board. A write replaces it atomically or not at all.
- Task and queue behavior is deterministic. Pomegr verifies conditions from committed
  facts; it makes no AI judgment about whether work is complete, and the own condition
  is judged by the agent and labeled as such.
- Missing evidence is not success. A session that vanished is Stalled only after its
  end is established, and leaves Stalled only on its own report or a confirmed live
  reading; unknown is shown as unknown.
- Ready order is the start order. The queue never starts a card ahead of the first
  waiting card of Ready, except the waiting members of that card's own parallel group, and
  it starts nothing while a task outside the group is in flight.
- A group exists only while two or more of its members count: in the queue, or planned in
  Backlog or Ready. A write that leaves one member removes the membership in the same
  transaction.
- A task that runs after a task that is not Done never starts, by the queue or by hand,
  and holds nothing behind it. No list makes tasks wait for each other.
- A migration of feature steps starts, relaunches, and steers no session, deletes no
  task, and stands only if the board projects.

## Open questions and unassigned work

Each item is owned by the product owner; none is implemented until they answer.

1. **Report-less completion.** May a deterministic condition, for example the pull
   request being merged, complete a task when the agent never reported? Do not
   implement it; a session that ended without a report is Stalled, and a task whose
   session has not reported waits for the user.
2. **Same-computer browser writes.** The owner answered the browser-read question on
   2026-10-10: a paired device reads the board and sends task actions (see
   [Paired devices](#paired-devices)). A same-computer browser still only reads; whether
   it should write too is not decided.
3. **Product wording.** The root README, `PRODUCT.md`, the package description, the
   plugin readmes, the landing pages, the public settings guide, the tray tooltip and
   its test, and the
   [product positioning decision](../decisions/product-positioning.md) still call
   Pomegr a read-only observer. Observation is read-only; the product now also starts
   sessions and has an [agent chat](agent-chat.md). No delivered change owned those files.
4. **Board deep links.** The board has no address for one task, so
   Open on board in the session view opens the board only, and a task
   ID on the Sessions list opens the board instead of the session's Task tab. A feature has
   an address since task T-93: a session's feature link opens it.
5. **Session start outside Windows.** Other platforms answer the fixed
   `unsupported_platform` result until a launcher is validated for them.

## Known defects

The acceptance review of 2026-10-08 passed the privacy, mutation, spawn, and binding
rules and reported seven defects. The follow-up of 2026-10-09 fixed them, and the sections
above now describe the fixed behavior. The first run on a device, on 2026-10-09, found
three more, one of which (a start with a plugin too old for tasks) is fixed. A fourth (`add_task` from an unlinked session in a task worktree targeted another board) closed on 2026-10-10, when a linked worktree took its main repository's identity. A fifth (the task modal kept its start line after the task changed) closed on 2026-10-10: the line and the lock now hold only while the board shows the task as it was when the start was made. A sixth (a held manual start did not say which gate holds) closed on 2026-10-10: the modal names the holding gates from the board's readings, and queue order no longer holds a manual start. The stated limits of the age rule for complete-when conditions are listed under
[Completion](#completion).

None is open. The earlier defect that `queue.gates.next` did not say why a task waits
behind a started task without a feature closed on 2026-10-13 (task T-94): a task in flight
outside the next task's group is its `blockedBy`, with the reason `earlier_task`.

Proven on a device on 2026-10-09 (Windows, Claude Code, plugin 0.9.0): a started session
opens as the user's own Claude Code, in the repository root and in a new task worktree;
it links to its task; `complete_task` and `add_task` are accepted with the hook's proof;
Mark done and Requeue work on a linked task with no report and leave the session running,
and the requeued session's later report is refused; a started task is not the queue's next
task; a dirty task worktree refuses a manual start and pauses the queue with
`worktree_dirty`, and Open folder opens it. On 2026-10-10 the owner started a Claude Code
session for a task with one image: the prompt named the image as `[Image #1]` with its
file, and the session read the file through `--add-dir` with no permission prompt.

Not yet proven on a device: that Codex takes `--image` after the prompt for a task with
images, that Codex sends the thread identity the binding reads, a
Codex session start, the Stalled state after a real session end, a checked complete-when
condition, and a tool call that waits at a permission prompt inside the proof window.

## Change and verify

Route the change with the [agent workflow](../development/agent-workflow.md), then run
the focused commands of the owning row. A change that adds a field, route, tool, or
surface to the task data class updates the [Privacy](#privacy) section of this page and the
[user guide](../../public/using-pomegr/tasks.md) together. `server/tasks/` has its own
layer rule (`server-tasks-layer`) in `.dependency-cruiser.cjs`. Run
`npm run check:boundaries` for import direction and `npm run check:docs` for this
page.
