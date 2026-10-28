# Aril operator: build, review, and merge while the owner is away

> Status: proposed; the owner answered the scope questions on 2026-10-24 and the open decisions on 2026-10-25, and reviews this plan before any build.
> Created: 2026-10-24.
> Scope: let Aril run the delivery loop for a repository while the owner is away: pick the next unblocked work, start a builder session, start a separate reviewer session on the result, send failed work back, merge on green CI and a passing review, start the next task, write tasks for the next step of an accepted plan, and report to the owner. It covers the standing grant that authorizes this, the event wake-up, the reviewer session, send-back, merge, the action log, and the boundary changes. It reuses the gaps of the [purpose roadmap](purpose-roadmap.md) (G6 to G10, G13) instead of redefining them.
> Continuation owner: the product owner decides; the agent that builds a phase records its evidence in the checkpoint.
> Authority: working plan. `AGENTS.md`, [Agent chat](../architecture/agent-chat.md), and [Tasks](../architecture/tasks.md) govern shipped behavior until each phase changes them.
> Next task or decision: phase 8, the acceptance run, which needs the owner.
> Completion criteria: a grant runs a repository's Ready tasks to merged pull requests with no owner action between tasks, every action is in the log, the owner can stop it at once, and every rule below has a test.
> Permanent destinations: `AGENTS.md` for the control boundary, [Agent chat](../architecture/agent-chat.md) for the grant, wake-up, and Aril's actions, [Tasks](../architecture/tasks.md) for send-back, review verdicts, and merge, the agent chat privacy section for the log, and a page in `docs/internal/design/` for the grant and the log.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Summary

Today Aril runs only when the owner sends a message, reads the board and the repository, and proposes; the owner applies every change.
The work the owner wants delegated is a loop that an agent already ran by hand on 2026-10-24 for Pomegr itself:

1. Choose the next unblocked work from the board and the accepted plans, and skip anything that needs the owner.
2. Write a precise brief from the repository's own rules and code.
3. Start a builder session in its own worktree.
4. When it ends, review the diff against the brief, run the focused tests, and check visible changes.
5. Send failed work back with the evidence, up to a limit.
6. Open the pull request if the builder did not, wait for CI, and merge when CI is green and the review passed.
7. Report the task complete for the owner's later **Mark done**, and start the next task.
8. Report what happened, and list only the decisions that need the owner.

Steps 1, 2 and 8 are judgment that Aril already has the reads for. Steps 3 to 7 need authority that Aril does not have, and a way to wake up when something finishes.
This plan adds that authority as a **standing grant** that the owner approves before leaving, and keeps Aril itself read-only: every change goes through a fixed, validated action, and testing runs in a separate reviewer session.

## Owner decisions

| Date | Decision |
| --- | --- |
| 2026-10-24 | Under a grant, Aril may start Ready tasks, review and send back, merge on green, and write new tasks from accepted plans. |
| 2026-10-24 | The reviewer is a separate session that Aril starts in the task's worktree. Aril reads its verdict and stays read-only. |
| 2026-10-24 | Plan first: the owner reviews this plan before any build. |
| 2026-10-25 | Limits are not fixed defaults. The owner and Aril settle them for what is on the plate, and they live in **Aril settings** in the app. Aril may ask what it can and cannot do. |
| 2026-10-25 | The merge method is the repository's own. |
| 2026-10-25 | Aril learns each repository and how the owner likes it to work, through a repository memory. It asks more and decides less at first, and settles rules with the owner over time. A work rule may select by tag, content, project, feature, or a list of tasks. |
| 2026-10-25 | The reviewer choice has no built-in bias: it follows the repository's rule, or what the owner settled, informed by Pomegr's metrics, or a combination. |
| 2026-10-25 | A paired device can talk with Aril and settle all of this. A setting, off by default, lets the owner allow paired devices to manage Aril settings and grants. |
| 2026-10-25 | Aril proposes every Aril settings change and the owner accepts it. The paired-device setting is the exception: only the owner sets it, only in the desktop app, and Aril never proposes it. |
| 2026-10-25 | A grant's limits count tasks, not sessions: how many tasks it takes on and how many run at a time, plus a provider usage limit. A task's build, review, and send-backs are one task. |
| 2026-10-25 | Merge, auto-merge, and branch deletion are settled with the owner, after consulting the repository's own rules and GitHub settings. |
| 2026-10-25 | Aril may propose removing task worktrees to free disk space; the owner confirms each removal. |
| 2026-10-25 | A settled rule is not asked again. Aril asks again only when it detects a change in the repository's workflow or the owner says the rule changed. |
| 2026-10-25 | A concurrency limit may later also weigh the machine's load; Pomegr has no machine-usage metric yet. |
| 2026-10-26 | Acceptance settled with Aril is enough: under a grant with **Mark done** on, Pomegr marks a merged task Done when every Complete when check passes on a fresh reading and its review passed, so a runs-after chain continues without the owner. `user_validated` and a task with no Complete when check stay the owner's (T-182). |

## Lessons from the first pilot

The first pilot (see the [retrospective](purpose-roadmap.md#retrospective-of-the-first-pilot)) also gave Aril grants, and the owner revoked most of them.
This plan answers each finding before it widens authority:

| Finding | Answer here |
| --- | --- |
| 1. A person chose the model | The grant names no models; G6 chooses each session's model and records why. The reviewer's model follows the reviewer rule, with Pomegr's metrics as evidence. |
| 2. The repository's process was skipped | The builder brief and the reviewer brief both start from the repository's own rules (G3). The reviewer checks them and reports met, unmet, or unknown for each. |
| 3. Proof was missing | Merge requires G4 proof presence and CI green on the pull request's head. |
| 4. Dependencies waited for the owner | An order dependency is satisfied by a passing review, not by **Mark done** (G10). |
| 5. Cards did not say how to deliver | Aril refuses to start a task whose delivery path (push, pull request, proof recipe) is unknown, and lists it for the owner (G7). |
| 6. Failures stayed silent | Every refusal, wait, and failure is a log entry and, when it needs the owner, an inbox item (G13). Quota waits do not consume rounds (G11). |
| 7. The owner watched | The log and the inbox replace watching; the grant has a stop that takes effect at once. |

## The grant

A grant is one record per repository, set in the desktop app only, and shown on the Tasks page while active.

- **Scope:** which actions it allows (start, review and send back, merge, write tasks), each a separate switch.
- **Limits:** an end time, a maximum number of tasks, a maximum of tasks at a time (at most the repository's queue limit), a send-back limit per task, and a provider usage limit that every grant start respects. None has a fixed default: the owner and Aril settle them for the work at hand.
- **Work set:** the board's Ready column in order, plus the tasks and plans that the repository's work rules select. Nothing else.
- **Stop:** one action ends the grant at once. Running sessions continue (Pomegr never ends a session); Aril starts, sends back, and merges nothing more.
- **Expiry:** the grant ends at its end time, when its limits are reached, or when the app quits; it never renews itself.
- Paired devices can see and stop a grant. They can create or change one only when the owner turned on the paired-device setting in Aril settings, which is off by default.

## Aril settings

Aril settings are one record per repository in the app, next to the grant:

- the grant's limits and switches, as settled for the next run;
- the work rules: which tasks and plans Aril may take, selected by tag, content, project, feature, or a list of tasks;
- the reviewer rule, when the repository or the owner set one;
- whether a paired device may manage settings and grants (off by default; set by the owner in the desktop app only).

The owner edits them directly. Aril changes them only through a proposal that the owner accepts, the same way it changes the board today, so it never widens its own authority.
The paired-device setting is the exception: the owner sets it only in the desktop app, Aril cannot propose it, and no paired device can change it.
The owner and Aril settle them in the chat: Aril proposes values for what is on the plate, and asks what it may do when a rule is missing.

## Repository memory

Aril keeps a memory per repository of how the owner likes the work done: delivery habits, merge method, review expectations, what needs the owner, and the rules settled in past conversations.

- It starts empty. With little memory Aril asks more and decides less; each settled answer becomes a memory entry or an Aril setting.
- Each entry is written through a proposal the owner applies, and the owner can see, edit, and delete every entry.
- An entry guides Aril's judgment; it never grants an action. Authority comes only from the grant and Aril settings.

## How Aril wakes

Aril runs today for each owner message. Under a grant it also runs on **committed events**, each one turn:

- a task session ended or reported complete or blocked;
- a reviewer session returned a verdict;
- a pull request's CI on its head finished;
- a pull request merged;
- the grant started, or a limit or the end time is near.

Events come from what Pomegr already records: task reports, the task outcome record (G1), session observation, and pull-request facts. Each event has a durable cursor, so a restart neither loses nor repeats one (the "committed events" idea deferred in the roadmap becomes this phase).
A turn that finds nothing to do ends without a provider call when a deterministic check can decide that.

## Aril's actions

Aril stays a read-only provider run. Each action below is a fixed operation that Pomegr validates and performs, the same way an applied proposal is today, but without the owner's click while a grant allows it.

| Action | Rule | Reuses |
| --- | --- | --- |
| Start a task | Ready, unblocked, selected by a work rule, delivery path known, within limits; model chosen by G6 | Task dispatch and the terminal host |
| Start a review | After a task reports complete; same worktree; brief lists the task, the brief, the repository rules, and the proof recipe | Task dispatch, with a reviewer role |
| Send back | After a failing verdict, within the send-back limit; a new builder session in the same worktree with the verdict as its brief (G9) | Task dispatch; Continue's resume path where the provider supports it |
| Merge | Pull request open, CI green on its head, review passed, proof present (G4), no unresolved review comments, branch protections satisfied; the repository's own merge method | A new desktop action through `gh`, owner-only today |
| Report complete | After merge; the task stays in Review for the owner's **Mark done**, unless Mark done below applies | `complete_task` semantics |
| Mark done (T-182) | **Mark done** switch on; the task is in the work set, its pull request merged, a fresh check reading shows every **Complete when** check passed (unavailable is no pass), its review passed when reviews are on, **Complete when** has at least one check and no `user_validated`, and it is neither blocked nor stalled. Logged as `grant_done`; it is no new grant task | The owner's Mark done write (`markTaskDone`) and the report's fresh check read |
| Write tasks | From the next unbuilt step of a plan a work rule selects, with full text, **Complete when**, and dependencies | The existing task add path |

Every action writes one log entry. A refused action records its fixed reason.

## The reviewer session

- Started by Aril, in the task's worktree, after the builder reports complete.
- Its provider and model follow the repository's reviewer rule or what the owner settled, informed by Pomegr's metrics (first-pass rate, review outcomes); Pomegr adds no default preference.
- Its brief: the task text, the builder brief, the repository's rules and proof recipe, and the diff range.
- It runs the repository's focused and full checks, inspects visible changes when the repository can render them, and writes a verdict through a new MCP report: `pass`, or `fail` with reasons, each reason one line.
- It changes no code. A reviewer that edits files fails its own verdict.
- Aril reads the verdict and decides send-back or merge. The verdict is stored with the task outcome (G1), so the scorecard can count first-pass reviews.

## The log and the inbox

- **Log:** each Aril action, refusal, wake-up, and verdict, with time, task, and reason. Counts, states, task IDs, pull-request numbers, and fixed reasons only; no prompt, response, or code. Stored with the task board; shown in the desktop and on a paired device.
- **Inbox (G13):** only what needs the owner: a task Aril refused to start and why, a task out of send-backs, a merge blocked by something only the owner can fix, a plan step that needs a decision.

## Grant follow-ups (T-183)

While a grant works, Aril sends the owner short follow-ups, so the owner need not ask what happened.

- After grant task-log entries (`grant_start`, `grant_review`, `review_passed`, `review_failed`, `sent_back`, `grant_merge`, `grant_merge_auto`, `grant_merge_refused`, `grant_branch_deleted`, `grant_branch_delete_refused`, `grant_done` once it exists, `grant_usage_hold`, `grant_usage_resume`) and when the grant ends, Pomegr appends one Aril line to that repository's chat, in the repository's one `Grant follow-ups` conversation.
- The line is a fixed template: one or two sentences with the task IDs, what happened, and what needs the owner or what is next. No provider runs: a turn that needs nothing ends without a provider call.
- Entries that arrive close together are one follow-up: a merge, its branch delete, and the next start are one line.
- The same line is one OS notification through the provider-notifications path, and a tray entry on a paired device. Its click opens that repository's chat at the follow-up; a session notification still opens its session.
- The **Send follow-ups** switch (`followUps`, on by default) is in Aril settings.
- A follow-up proposes, applies, and starts nothing, and is never an owner message.
- Contracts: [Agent chat: Grant follow-ups](../architecture/agent-chat.md#grant-follow-ups), [Tasks: Grant follow-ups](../architecture/tasks.md#grant-follow-ups), and [Notification privacy](../architecture/privacy/notifications.md#aril-follow-ups).

## Boundary changes

These change `AGENTS.md` and the owner pages, each in the phase that ships it:

- "Aril changes and starts nothing" becomes: Aril changes and starts nothing, except through the fixed grant actions while an owner-approved grant is active.
- The grant actions join the list of control actions with their confirmation boundary: the grant itself is the owner's confirmation, scoped and time-bound.
- Merge becomes a control action Pomegr may perform, only under a grant and only with the checks above.
- Terminal input stays owner-only. Aril never types into a session and never ends one.

## Phases

Each phase ships on its own and is useful without the next.

- [x] **1. Log and events.** The action log store and view, and committed events with durable cursors, with no new authority. Aril can be asked "what happened since I left" from the log.
- [x] **2. Reviewer session.** The reviewer role, its brief, and its verdict report; started by the owner from a task in Review. Verdicts recorded with G1.
- [x] **3. Settings and memory.** Aril settings and the repository memory, both changed by the owner or by an applied proposal; the desktop-only paired-device setting. No new authority.
- [x] **4. Grant with start and review.** The grant record, its limits and stop; Aril starts the tasks its work rules select, and their reviews, on events. Owner merges.
- [x] **5. Send-back.** Failing verdicts go back to a builder session within the limit (G9).
- [x] **6. Merge on green.** The merge action with every check above.
- [x] **7. Tasks from plans.** Aril writes tasks for the next step of a plan its work rules select.
- [ ] **8. Acceptance.** Experiment 2 runs under a grant; record whether its targets passed.
- [x] **9. Owner refinements.** The owner's decisions of 2026-10-25 after phase 7, each its own slice:
  - [x] 9a. Limits by tasks and usage: the tasks limit and tasks at a time replace starts and concurrent sessions; the usage limit holds every grant start while the provider that would run is at or above it, or its usage is unknown.
  - [x] 9b. Merge settings: merge or auto-merge, and branch deletion, each settled or the repository's own; Aril sees the repository's GitHub merge settings.
  - [x] 9c. Worktree cleanup: Aril sees the task worktrees that remain and proposes removing them; the owner applies each removal.
  - [x] 9d. Settled rules: Aril does not ask again what memory or settings settled, and sees when the repository's workflow sources changed since a rule was settled.
  - [x] 9e. Review terminals: the terminal view lists a review session, so the owner can watch it.
  - [x] 9f. Docs and pages: the Home dashboard, the landing page, and the public guides describe what Aril does under a grant.
- Later: a machine-usage metric that a tasks-at-a-time limit can weigh.

Phases 1 to 3 add no authority.

## Failure behavior

- Any action whose checks cannot be evaluated (for example, CI facts unavailable) is refused with a reason; Aril never assumes green.
- A crashed or restarted app resumes from the event cursor; an action performed but not logged is detected from its result (a session, a merge) and logged once.
- Two events for the same task are handled in order; a merge is attempted at most once per head commit.
- When the provider that would run is at or above the usage limit, or its usage is unknown, the grant starts nothing and the log says so.

## Checkpoint

2026-10-24: plan written after the owner asked what Aril lacks to run the delivery loop an agent ran by hand that day. The owner answered the scope questions (start, review and send back, merge on green, write tasks; a separate reviewer session; plan first). Next action: the owner reviews the plan and answers the open decisions.
2026-10-25: the owner answered the five open decisions (recorded under Owner decisions). Added Aril settings, the repository memory, and phase 3; removed fixed default limits and the squash default. Next action: the owner reviews the revised plan.
2026-10-25: the owner decided that Aril proposes every settings change for the owner to accept, except the paired-device setting, which only the owner sets, in the desktop app.
2026-10-25: phase 1 shipped in #313 (task log and cursor), #315 (pull-request events), #316 (Aril reads the log since its last answer), #317 (desktop Log panel), and #318 (Log on a paired device). Phase 2 started: the reviewer session's monitor side (plan, bind, verdict, outcome fields). Next action: the desktop review start, the report_review MCP tool, and the verdict on the board.
2026-10-25: phase 2 shipped in #319 (monitor side: plan, bind, verdict, outcome fields), #320 (report_review tool, plugins 0.9.15), #321 (desktop Start review), and the verdict on the task and in Aril's snapshot. Next action: phase 3, Aril settings and the repository memory.
2026-10-25: phase 3 shipped in #323 (settings and memory store), #324 (Aril settings panel), and #325 (Aril reads and proposes settings and memory). Phase 4 started: the grant record and the monitor's grant read. Next action: the desktop grant runner with the boundary change, then the grant controls.
2026-10-25: phase 4 shipped in #326 (grant record and grant read), #327 (desktop grant runner and the AGENTS.md boundary change), #328 (grant reviews follow the reviewer rule), and #329 (grant controls). Phase 5 (send-back) ships with this checkpoint. Next action: phase 6, merge on green.
2026-10-25: phase 6 shipped in #331 (merge on green) and #332 (a passing review meets an order dependency under a grant); phase 7 in #333 (plan rules and grant-written tasks) and this change (the grant run that writes tasks). Next action: phase 8, the acceptance run of experiment 2 under a grant, which needs the owner; and the owner's wording for the Home and landing claims that Aril never acts.
2026-10-25: phase 7 shipped in #333 and #334. The owner refined limits, merge, worktree cleanup, settled rules, and the docs (phase 9). Next action: phase 9 slices; phase 8 still needs the owner.
2026-10-25: phase 9d built: Aril treats its settings and memory as settled, and the desktop lists the workflow sources that changed after the oldest settled time. Next action: the other phase 9 slices.
2026-10-25: phase 9c built: Aril sees the task worktrees that remain and proposes removing them, and the owner applies each removal in the desktop app. Next action: the other phase 9 slices; phase 8 still needs the owner.
2026-10-25: phase 9 shipped (#336–#340 and this change). Next action: phase 8, the acceptance run, which needs the owner.
2026-10-26: T-183 built grant follow-ups: a coalesced fixed line in the chat and one notification for each burst of grant entries and for the grant's end, behind the `followUps` setting. The owner then decided that acceptance settled with Aril is enough to mark a merged task Done under a grant; T-182 built the **Mark done** action. Next action: phase 8, the acceptance run, which needs the owner.
