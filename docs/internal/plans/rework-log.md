# Rework log: record when work is redone, and let Aril learn from it

> Status: active; R1 and R2 are done; R3 is next.
> Created: 2026-10-25.
> Scope: a recorded link that says one piece of work reworks an earlier one, with its cause; where it is declared, how the task log, Aril's snapshot, and the model record show it, and one scorecard measure. Pre-merge rework that Pomegr already records (send-backs, failed reviews, owner requeues) is counted, not redeclared.
> Continuation owner: the product owner decides; the agent that builds a slice records its evidence in the checkpoint.
> Authority: working plan. `AGENTS.md`, [Tasks](../architecture/tasks.md), [Agent chat](../architecture/agent-chat.md), and [MCP tools](../../public/using-pomegr/mcp-tools.md) govern shipped behavior until each slice changes them.
> Next task or decision: build R3.
> Completion criteria: a rework declared by a session, Aril, or the owner appears in the task log and in Aril's snapshot, counts in the model record, and moves the rework measure on the scorecard; every rule below has a test.
> Permanent destinations: [Tasks](../architecture/tasks.md) for the record, the log kind, and the privacy row; [Agent chat](../architecture/agent-chat.md) for the snapshot and the proposal operation; [MCP tools](../../public/using-pomegr/mcp-tools.md) for the tool field; [Metrics](../architecture/metrics.md) for the measure; the task board design page for the panel and the task window.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Summary

Work that ships and then needs a fix is the most direct evidence that a brief, a review, or a model choice missed something.
Pomegr records the pre-merge part today (`sent_back`, `review_failed`, `requeued`) but nothing links a later fix to the work it repairs.
This plan adds that link, with a cause, so Aril can see which kinds of work get redone, which models and efforts produced them, and which miss repeats, and propose a memory line that turns a repeated miss into a checklist item for the next brief.

## Owner decisions

| Date | Decision |
| --- | --- |
| 2026-10-25 | Rework counts before merge (send-backs, failed reviews) and after merge (fix pull requests). |
| 2026-10-25 | Whoever detects it first declares it: the session that does the fix, Aril, or the owner. A link needs no per-link confirmation from the owner. |
| 2026-10-25 | Aril records a link directly, without Apply, limited to links with a cause from the list; each one shows in the log. R3 adds this narrow exception to `AGENTS.md`. |

## Worked examples

Four fixes on 2026-10-25 reworked the Aril operator slices merged the same day. Each had a different cause:

| Fix | Reworks | Cause | What would have caught it |
| --- | --- | --- | --- |
| #342 | #336 | `missed_wiring`: the client board parser dropped the new `aril` field | A check that a new served field reaches the client parser |
| #343 | #336, #340 | `missed_wiring`: the desktop IPC allow-list missed the new actions | The same check for task actions: store, route, preload, renderer |
| #344 | #341 | `stale_instructions`: the prompt still described Aril as proposal-only | Updating Aril's capability text with each capability |
| #345 | none | `latent`: the board snapshot grew past the prompt limit on a large board | A budget test at board scale |

#345 repairs no recent change, so it records no link: a link needs an earlier piece of work it reworks.

## The record

- A rework link is `{ fix, reworks, cause, declaredBy, at }` in one repository.
- `fix` and `reworks` are each a board task (`T-n`) or a pull request of the repository (`#n`). A pull request needs no board task: work done outside the board still counts.
- `cause` is one of a fixed list: `missed_wiring` (a layer or list was not updated), `spec_gap` (the brief left it out), `wrong_behavior` (the change did the wrong thing), `stale_instructions` (docs, prompts, or instructions were not updated), `latent` (an older defect a change exposed), `other`.
- `declaredBy` is `session`, `aril`, or `owner`.
- One link per `fix` and `reworks` pair; a second declaration of the same pair is ignored, so the first one stands.
- A link never changes either task's column, state, or outcome.
- Pre-merge rework is not redeclared: `sent_back`, `review_failed`, and `requeued` log entries already count as rework of their task, with cause from the review reasons when present.

## Who declares

- **The fixing session.** `complete_task` and `block_task` take an optional `reworks` list (`[{ "ref": "T-12" | "#336", "cause": "missed_wiring" }]`, at most 5). The route's exact-key check and the plugin hook field list change with it.
- **Aril.** A `declare_rework` operation that Pomegr records without Apply, the narrow exception the owner chose on 2026-10-25.
- **The owner.** A **Reworks** field in the task window: a task or pull request number and a cause.

## Where it shows

- **Task log:** a new kind `rework`, on the fixing task when it is a task; a link whose fix is a pull request without a task logs with its pull request number and no task.
- **Aril's snapshot:** per task, `reworks` and `reworked_by` as references with causes, and a short `rework` summary of the last 30 days: counts by cause, and by the provider, model, and effort that built the reworked work.
- **Model record:** "Weigh the record" counts a reworked task as a weaker result for its model and effort than a task that merged clean.
- **Aril memory:** when one cause repeats for the same kind of work, Aril proposes an `add_memory` line that names the check, such as "A new task action must pass through the store, the route, the preload allow-list, and the client parser."
- **Scorecard:** one measure, rework rate: merged tasks in the window that were sent back, failed a review, were requeued, or are named by a rework link, divided by merged tasks. Values stay on this computer, as every scorecard value does.

## Privacy

A link holds only references, a cause from the fixed list, the declarer, and a time: no free text. It crosses where the task log already crosses (the desktop, a paired device, Aril's prompt). The scorecard measure stays in the desktop.

## Slices

| Slice | Delivers | Measure |
| --- | --- | --- |
| R1 | The record, the `rework` log kind, the owner field in the task window | Links recorded per week |
| R2 (done) | The `reworks` field of `complete_task` and `block_task`; plugin and docs | Share of links declared by sessions |
| R3 | Aril: the snapshot fields, the 30-day summary, the model-record rule, the proposal operation, the memory suggestion | Rework rate trend after Aril memory lines exist |
| R4 | The scorecard measure and its panel row | Rework rate |

## Checkpoint

- 2026-10-25: plan written from the code map of the task log, the pull-request facts, the MCP task tools, the proposal operations, the snapshot, and the scorecard. Next action: the owner reviews it.
- 2026-10-25: the owner accepted the plan and chose the direct record for Aril. Next action: build R1.
- 2026-10-25: R1 shipped: the `task_rework` record (first declaration stands, at most five per fix, no task state change), the `rework` log kind (a pull-request fix logs with its number and no task), the owner's `rework_declare` and `rework_remove` actions on the desktop and a paired device, and the **Reworks** row in the task window. Next action: build R2.
- 2026-10-25: R2 done in source: both report tools accept bounded rework declarations; the report and session links share one transaction, with fixed per-reference outcomes. Proof: 84 focused Node tests, lint, docs, architecture, dependency boundaries, and `verify:fast` pass. Plugin bundles remain for reviewer regeneration; no build ran. Next action: build R3.
