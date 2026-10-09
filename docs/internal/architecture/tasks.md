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
| Task store, board read, Tasks tab | Not built |
| Task creation, run-on and done-when fields, move, columns, features | Not built |
| Queue view and ordering | Not built |
| Agent tool `add_task` | Not built |
| Start a Claude Code session and bind it to its task | Not built |
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
| `server/tasks/` | Task store, record validation, board projection, queue rules, done-when checks, start gates | `server/runtime/` or `server/serving/` (dependency-cruiser rule `only-entry-points-import-runtime-and-serving`); a `server-tasks-layer` rule beside the other layer rules will enforce the rest |
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
pattern of `monitor-store.mjs`).

- The store is versioned. A malformed or newer store is never overwritten by a routine
  write; the board then reports `unavailable`.
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
  queue: { status: "idle" | "running" | "blocked" | "paused"; blockedBy: string | null };
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
  evidence, the planned one is intent.
- `doneWhen.own` is a free-text condition that the agent judges. Pomegr does not
  evaluate it.
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
and only one start at a time subject to the gates below. Exact ordering and tie-break
rules are recorded here when the part that implements them lands.

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

Claude Code and Codex are both startable. Pomegr never attaches to, writes input to,
approves for, or stops the started process; afterwards it only observes the session
like any other.

## Boundaries

| Surface | Who | What it carries |
| --- | --- | --- |
| `GET /api/tasks?repositoryId=repo-<24 hex>` | A same-computer client, gated like `GET /api/provider-folders`; not on the LAN gateway list | The committed board, `no-store`. A denied client gets `readiness: "desktop_only"` and no task content |
| `pomegr:task-action` IPC | The renderer, through a trusted main frame only | A fixed action name, the repository ID pattern, and a payload of at most 16 KiB |
| `POST /internal/tasks/<action>` | Desktop main, with the desktop token | The same action; the monitor validates the whole record |
| `POST /api/agent/v1/tasks/add\|complete\|block` | An agent through the MCP tools, authorized like the agent-query GETs | The only agent writes; no other path may be added without updating the AGENTS.md rule |

- The fixed IPC actions are `create`, `update`, `delete`, `move`, `column_create`,
  `column_rename`, `column_reorder`, `column_delete`, `feature_create`, `queue_add`,
  `queue_remove`, `queue_reorder`, `queue_settings`, `resolve_done`, and
  `resolve_requeue`. An action whose part has not landed answers a fixed `unsupported`
  result.
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
