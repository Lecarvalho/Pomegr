# Task board and session dispatch

> Status: active; part 2 (`board-read`) ships the store, `GET /api/tasks`, and the read-only Tasks tab. No task can be created yet.
> Created: 2026-10-08.
> Scope: a per-repository task board and an opt-in desktop dispatcher. Tasks carry planned provider, model and effort, features with ordered steps, and done-when checks. A queue starts Claude Code and Codex sessions behind start gates and stops on trouble. Agents add, complete, and block tasks through Pomegr MCP tools. The Sessions list and session view show task identity. Observation stays read-only and untouched.
> Continuation owner: the Pomegr maintainer; each part is delivered by the session that owns it, and the product owner reviews and merges every pull request.
> Authority: working checklist. [Tasks](../architecture/tasks.md) and [AGENTS.md](../../../AGENTS.md) govern behavior and privacy; this plan only orders the work.
> Next task or decision: part 3 (`create-task`) once the part 2 pull request is open; the open questions below need the product owner before the parts that touch them.
> Completion criteria: all 21 parts have an open (then merged) pull request, the behavior they ship is recorded in the tasks contract, the public guide exists, and this plan is deleted.
> Permanent destinations: [Tasks](../architecture/tasks.md) (current behavior and invariants), [AGENTS.md](../../../AGENTS.md) (privacy rules), [agent workflow](../development/agent-workflow.md) (routing rows and the server layout row), `docs/public/using-pomegr/tasks.md` (user guide, written by part 21), and [DESIGN.md](../../../DESIGN.md) with the `/design-system` samples for any new shared control.
> Lifetime: temporary; the last part deletes this plan after transferring enduring findings, as described under [Closing the plan](#closing-the-plan).

The product owner decided on 2026-10-08 that Pomegr becomes an observer plus an opt-in
dispatcher, and authorized the 21 parts to run unattended, one pull request each. The
decisions are recorded as the [tasks contract](../architecture/tasks.md) and the
task-board rule in [AGENTS.md](../../../AGENTS.md); this plan does not restate them.
The UI follows an approved design canvas (version 12, claude.ai artifact
`R8wRaxXAXbJBfA5FQF2Siu`) mapped onto the shared tokens and button roles in
[DESIGN.md](../../../DESIGN.md); the drawings use literal colors that a part must
replace with tokens.

## Parts

Each part has the branch `tasks/<nn>-<slug>`, where `<nn>` is the two-digit part
number.

| # | Slug | Branch | Base | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `charter` | `tasks/01-charter` | `main` | Purpose, privacy rules, and design contract (this change; documentation only) |
| 2 | `board-read` | `tasks/02-board-read` | `tasks/01-charter` | Stored tasks shown on a repository Tasks tab |
| 3 | `create-task` | `tasks/03-create-task` | `tasks/02-board-read` | New task panel creates a task from the desktop app |
| 4 | `task-fields` | `tasks/04-task-fields` | `tasks/03-create-task` | Run on, effort, and Done when on tasks |
| 5 | `move-and-columns` | `tasks/05-move-and-columns` | `tasks/04-task-fields` | Drag cards and manage columns |
| 6 | `features` | `tasks/06-features` | `tasks/05-move-and-columns` | Attach tasks to features and see their siblings |
| 7 | `queue-view` | `tasks/07-queue-view` | `tasks/06-features` | Queue view with steps and reordering |
| 8 | `mcp-add-task` | `tasks/08-mcp-add-task` | `tasks/07-queue-view` | Agents add tasks through the Pomegr MCP server |
| 9 | `start-claude` | `tasks/09-start-claude` | `tasks/08-mcp-add-task` | Start a Claude Code session for one task |
| 10 | `bind-session` | `tasks/10-bind-session` | `tasks/09-start-claude` | Link a started session to its task and borrow its state |
| 11 | `start-codex` | `tasks/11-start-codex` | `tasks/10-bind-session` | Start and bind a Codex session for a task |
| 12 | `complete-and-block` | `tasks/12-complete-and-block` | `tasks/11-start-codex` | Agents report done or blocked; Pomegr verifies the checks |
| 13 | `ci-check` | `tasks/13-ci-check` | `tasks/12-complete-and-block` | CI passed as a verified condition |
| 14 | `stalled` | `tasks/14-stalled` | `tasks/13-ci-check` | A session that ends without a report stalls its task |
| 15 | `queue-advance` | `tasks/15-queue-advance` | `tasks/14-stalled` | The queue starts the next task and blocks on trouble |
| 16 | `start-gates` | `tasks/16-start-gates` | `tasks/15-queue-advance` | Usage, provider status, and clean-tree gates before a start |
| 17 | `parallel-steps` | `tasks/17-parallel-steps` | `tasks/16-start-gates` | Tasks of one step start together, one worktree each |
| 18 | `schedule` | `tasks/18-schedule` | `tasks/17-parallel-steps` | Start at a time and stop starting after a time |
| 19 | `sessions-task-column` | `tasks/19-sessions-task-column` | `tasks/18-schedule` | Task and feature on the Sessions list |
| 20 | `session-task-tab` | `tasks/20-session-task-tab` | `tasks/19-sessions-task-column` | Task summary on Overview and a Task tab in the session view |
| 21 | `acceptance` | `tasks/21-acceptance` | `tasks/20-session-task-tab` | Evidence, review, public guide, and plan retirement |

## Working rules

- **Sequential base.** Parts never run together. Part N branches from part N-1's branch,
  or from `main` when that branch has already merged, and its pull request targets that
  same base.
- **Definition of done.** The part's pull request is open. A session never merges; the
  product owner merges each pull request.
- **Before handing off.** Run `npm run verify:fast`, the focused tests of the owning
  [routing rows](../development/agent-workflow.md), and `npm run build` for
  implementation changes. Never run `npm run build` and `npm run verify` concurrently,
  because both regenerate the plugin bundles.
- **UI evidence.** Evidence captures are deferred to part 21. Every visible part ends on
  a deterministic UI test instead, and follows `DESIGN.md` (six button roles, tokens
  only, a `/design-system` sample for any new shared control).
- **Privacy.** A part that widens what crosses a boundary (a field, route, tool, or
  surface) updates the task rule in [AGENTS.md](../../../AGENTS.md) and the
  [tasks contract](../architecture/tasks.md) in the same pull request. Task text, the
  own condition, and column and feature names stay out of every observation surface.
- **Honest status.** Each part updates the status table of the tasks contract for what it
  built, and describes nothing unbuilt as shipped.

## Carried obligations

- Part 2 adds the `server-tasks-layer` rule to `.dependency-cruiser.cjs` and the
  `server/tasks/` row to the server layout in the agent workflow.
- Parts 13 and 19 each edit AGENTS.md and the tasks contract: the CI check source in
  part 13, and the Sessions-list projection (task ID, state, feature name, step) in part 19.
- Part 8 adds the first agent write paths; no other agent write path may be added without
  updating the AGENTS.md rule.
- Product wording that still calls Pomegr a read-only observer (root README and
  `PRODUCT.md`, the package description, plugin readmes, the landing pages, the
  public settings guide, the tray tooltip and its test, and the
  [product positioning decision](../decisions/product-positioning.md)) is accurate
  until the first part that starts a session ships. No part's scope names those files,
  so the product owner needs to assign them before the first session-starting part (9)
  ships.

## Open questions

1. **Report-less completion.** May a deterministic condition, for example the pull request
   being merged, complete a task when the agent never reported? Not implemented and not
   designed until the product owner answers. A session that ends without a report is
   Stalled.
2. **Browser read.** `GET /api/tasks` is read-only and is designed to follow the
   `GET /api/provider-folders` same-computer gate. Say whether even that read should be
   desktop only.

## Closing the plan

The last part (21) deletes this plan in its own change, without an archive copy. Before
deleting it:

1. Transfer current behavior and invariants to [Tasks](../architecture/tasks.md), remove
   its status table and its "designed, not built" wording once every part has shipped,
   and write the public guide.
2. Move reusable visual rules and samples into `DESIGN.md` and `/design-system`.
3. Give any unanswered open question or unfinished obligation a named owner in the
   tasks contract or an existing issue.
4. Repair every reference to this plan: the maintainer index entries, and the agent
   workflow routing rows and note that say their paths arrive with the task-board plan.
5. Run `npm run check:docs`.

## Continuation checkpoint

Part 1 (charter) records the purpose, the privacy rule, the tasks contract, the routing
rows, and this plan, and changes no code. The next action is part 2 (`board-read`),
which creates the task store, the committed board read, and the repository Tasks tab.
