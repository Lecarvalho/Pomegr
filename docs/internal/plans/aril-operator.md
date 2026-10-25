# Aril operator: build, review, and merge while the owner is away

> Status: proposed; the owner answered the scope questions on 2026-10-24 and reviews this plan before any build.
> Created: 2026-10-24.
> Scope: let Aril run the delivery loop for a repository while the owner is away: pick the next unblocked work, start a builder session, start a separate reviewer session on the result, send failed work back, merge on green CI and a passing review, start the next task, write tasks for the next step of an accepted plan, and report to the owner. It covers the standing grant that authorizes this, the event wake-up, the reviewer session, send-back, merge, the action log, and the boundary changes. It reuses the gaps of the [purpose roadmap](purpose-roadmap.md) (G6 to G10, G13) instead of redefining them.
> Continuation owner: the product owner decides; the agent that builds a phase records its evidence in the checkpoint.
> Authority: working plan. `AGENTS.md`, [Agent chat](../architecture/agent-chat.md), and [Tasks](../architecture/tasks.md) govern shipped behavior until each phase changes them.
> Next task or decision: the owner reviews this plan and answers the open decisions.
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

## Lessons from the first pilot

The first pilot (see the [retrospective](purpose-roadmap.md#retrospective-of-the-first-pilot)) also gave Aril grants, and the owner revoked most of them.
This plan answers each finding before it widens authority:

| Finding | Answer here |
| --- | --- |
| 1. A person chose the model | The grant names no models; G6 chooses each session's model and records why. The reviewer runs on a different model from the builder when one is available. |
| 2. The repository's process was skipped | The builder brief and the reviewer brief both start from the repository's own rules (G3). The reviewer checks them and reports met, unmet, or unknown for each. |
| 3. Proof was missing | Merge requires G4 proof presence and CI green on the pull request's head. |
| 4. Dependencies waited for the owner | An order dependency is satisfied by a passing review, not by **Mark done** (G10). |
| 5. Cards did not say how to deliver | Aril refuses to start a task whose delivery path (push, pull request, proof recipe) is unknown, and lists it for the owner (G7). |
| 6. Failures stayed silent | Every refusal, wait, and failure is a log entry and, when it needs the owner, an inbox item (G13). Quota waits do not consume rounds (G11). |
| 7. The owner watched | The log and the inbox replace watching; the grant has a stop that takes effect at once. |

## The grant

A grant is one record per repository, set in the desktop app only, and shown on the Tasks page while active.

- **Scope:** which actions it allows (start, review and send back, merge, write tasks), each a separate switch.
- **Limits:** an end time, a maximum number of starts, a maximum of concurrent sessions (at most the repository's queue limit), a send-back limit per task (default 2), and the provider allowance Aril's own runs may use.
- **Work set:** the board's Ready column in order, plus tasks written from plans the owner marked accepted. Nothing else.
- **Stop:** one action ends the grant at once. Running sessions continue (Pomegr never ends a session); Aril starts, sends back, and merges nothing more.
- **Expiry:** the grant ends at its end time, when its limits are reached, or when the app quits; it never renews itself.
- Paired devices can see and stop a grant; only the desktop can create one.

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
| Start a task | Ready, unblocked, delivery path known, within limits; model chosen by G6 | Task dispatch and the terminal host |
| Start a review | After a task reports complete; same worktree; brief lists the task, the brief, the repository rules, and the proof recipe | Task dispatch, with a reviewer role |
| Send back | After a failing verdict, within the send-back limit; a new builder session in the same worktree with the verdict as its brief (G9) | Task dispatch; Continue's resume path where the provider supports it |
| Merge | Pull request open, CI green on its head, review passed, proof present (G4), no unresolved review comments, branch protections satisfied; squash or the repository's configured method | A new desktop action through `gh`, owner-only today |
| Report complete | After merge; the task goes to Review for the owner's **Mark done** | `complete_task` semantics |
| Write tasks | From an accepted plan's next unbuilt step, with full text, **Complete when**, and dependencies | The existing task add path |

Every action writes one log entry. A refused action records its fixed reason.

## The reviewer session

- Started by Aril, in the task's worktree, after the builder reports complete.
- Its brief: the task text, the builder brief, the repository's rules and proof recipe, and the diff range.
- It runs the repository's focused and full checks, inspects visible changes when the repository can render them, and writes a verdict through a new MCP report: `pass`, or `fail` with reasons, each reason one line.
- It changes no code. A reviewer that edits files fails its own verdict.
- Aril reads the verdict and decides send-back or merge. The verdict is stored with the task outcome (G1), so the scorecard can count first-pass reviews.

## The log and the inbox

- **Log:** each Aril action, refusal, wake-up, and verdict, with time, task, and reason. Counts, states, task IDs, pull-request numbers, and fixed reasons only; no prompt, response, or code. Stored with the task board; shown in the desktop and on a paired device.
- **Inbox (G13):** only what needs the owner: a task Aril refused to start and why, a task out of send-backs, a merge blocked by something only the owner can fix, a plan step that needs a decision.

## Boundary changes

These change `AGENTS.md` and the owner pages, each in the phase that ships it:

- "Aril changes and starts nothing" becomes: Aril changes and starts nothing, except through the fixed grant actions while an owner-approved grant is active.
- The grant actions join the list of control actions with their confirmation boundary: the grant itself is the owner's confirmation, scoped and time-bound.
- Merge becomes a control action Pomegr may perform, only under a grant and only with the checks above.
- Terminal input stays owner-only. Aril never types into a session and never ends one.

## Phases

Each phase ships on its own and is useful without the next.

- [ ] **1. Log and events.** The action log store and view, and committed events with durable cursors, with no new authority. Aril can be asked "what happened since I left" from the log.
- [ ] **2. Reviewer session.** The reviewer role, its brief, and its verdict report; started by the owner from a task in Review. Verdicts recorded with G1.
- [ ] **3. Grant with start and review.** The grant record, its limits and stop; Aril starts Ready tasks and their reviews on events. Owner merges.
- [ ] **4. Send-back.** Failing verdicts go back to a builder session within the limit (G9).
- [ ] **5. Merge on green.** The merge action with every check above.
- [ ] **6. Tasks from plans.** Aril writes tasks for the next step of an accepted plan.
- [ ] **7. Acceptance.** Experiment 2 runs under a grant; record whether its targets passed.

Phases 1 and 2 add no authority and can start before the open decisions are answered.

## Failure behavior

- Any action whose checks cannot be evaluated (for example, CI facts unavailable) is refused with a reason; Aril never assumes green.
- A crashed or restarted app resumes from the event cursor; an action performed but not logged is detected from its result (a session, a merge) and logged once.
- Two events for the same task are handled in order; a merge is attempted at most once per head commit.
- When the provider allowance for Aril's runs is spent, the grant pauses and the inbox says so.

## Open decisions

1. **Default limits.** Proposed: end time 8 hours, at most 10 starts, concurrency at the queue limit, 2 send-backs per task.
2. **Merge method.** Squash for every repository, or each repository's own setting.
3. **Accepted plans.** How the owner marks a plan accepted for task writing: a field in the plan header, or a list in the grant.
4. **Reviewer model.** Whether G6 must choose a different provider from the builder's, or only a different model.
5. **Phone.** Whether a paired device may also create a grant, or only see and stop it.

## Checkpoint

2026-10-24: plan written after the owner asked what Aril lacks to run the delivery loop an agent ran by hand that day. The owner answered the scope questions (start, review and send back, merge on green, write tasks; a separate reviewer session; plan first). Next action: the owner reviews the plan and answers the open decisions.
