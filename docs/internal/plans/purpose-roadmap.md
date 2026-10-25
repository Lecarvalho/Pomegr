# Purpose roadmap: less supervision, more personal time

> Status: active; G5's separate Node and UI regressions are verified (2026-10-25). S4 wiring remains open.
> Created: 2026-10-17 as a Portuguese Aril proposal; replaced on 2026-10-19 by this English roadmap.
> Scope: the small versions that move Pomegr toward its purpose, the scorecard that measures each step, the 0.8.1 release without the pilot, how the other plans fit, and the readiness for a second autonomous experiment.
> Continuation owner: the product owner decides; the agent that picks up a version records its evidence here, without scorecard values.
> Authority: working plan. `AGENTS.md`, [Tasks](../architecture/tasks.md), [Agent chat](../architecture/agent-chat.md), [Metrics](../architecture/metrics.md), and [Observation cache](../architecture/observation-cache.md) govern shipped behavior. Each other plan keeps its own scope until the owner accepts its placement here.
> Next task or decision: the owner gives the go to tag and release 0.9.0, which is built on main, and holds the closeout debrief (G17); 0.9.1 work that needs no decision continues.
> Completion criteria: 0.8.1 ships without the pilot; each version ships with its scorecard values in the desktop; each gap is shipped, moved to its own plan, or dropped; the [readiness criteria](#readiness-for-experiment-2) pass; experiment 2 runs, and whether each target passed is recorded here.
> Permanent destinations: Tasks, Agent chat, Metrics, Observation cache, [session evidence privacy](../architecture/privacy/session-evidence.md), [desktop releases](../operations/desktop-releases.md) for the release-branch procedure, and [PRODUCT.md](../../../PRODUCT.md) for purpose wording.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Summary

Pomegr exists to give the owner personal time back.
That means less supervision of coding agents, fewer status checks, less context switching, and less review and rework.
Visibility, evidence, and Aril are means to that end.

The first autonomous pilot, on 2026-10-18, did the opposite.
The owner came back to many pull requests that needed review, rework, and manual validation.
The number of pull requests was not the problem: the owner needs pull requests to move projects forward.
The problem was that the owner had to check, correct, and prove every result.
The [retrospective](#retrospective-of-the-first-pilot) records the evidence.

The roadmap has three steps:

1. Ship 0.8.1 without the pilot.
2. Ship small versions. Each version makes one change toward the purpose and shows its effect on the [purpose scorecard](#purpose-scorecard).
3. Run experiment 2 on Claude only after the readiness criteria pass.

## Owner decisions

| Date | Decision |
| --- | --- |
| 2026-10-17 | The purpose is personal time for the owner. More accepted pull requests are a support measure, not the goal. |
| 2026-10-17 | The first audience is the developer who works alone, with several local projects. |
| 2026-10-17 | Entry for the solo developer stays free, permanently, not as a trial. Paid offers for teams may come later. Nothing is priced. [Commercial strategy](commercial-strategy.md) must be reconciled with this. |
| 2026-10-19 | The first pilot failed the purpose. |
| 2026-10-19 | The owner expects pull requests with proof: before and after, real data where allowed, and images for visible changes. Unit tests alone are not proof. |
| 2026-10-19 | Agents unblock themselves. The board shows only the owner's own actions, in a clear sequence. An agent helps the owner take over a task. |
| 2026-10-19 | Pomegr and Aril choose models from evidence. The owner can correct a choice, but the owner is not the source of the policy. |
| 2026-10-19 | Pomegr chooses the model of each task session. Each repository chooses its subagent models. Aril may propose a calibration change to a repository as a task in that repository. |
| 2026-10-19 | Repository rules are the authority. Pomegr adds no rule above them. Aril must know them and check the work against them. |
| 2026-10-19 | 0.8.1 excludes the pilot. The versions after it are for evidence and autonomy, plus bug fixes. |
| 2026-10-19 | Progress comes in small versions. Each version ships a small change and shows measured progress toward the purpose. |
| 2026-10-19 | Experiment 2 runs on Claude, for the coordinator and the task sessions. |
| 2026-10-19 | The **Aril pilot** panel is rejected. Shipped pilot code stays when it helps the new direction. |
| 2026-10-19 | The roadmap covers all of Pomegr, not only Aril. Other plans that serve the purpose join it. |
| 2026-10-19 | Every document is written in English. |
| 2026-10-21 | The owner spends about 5 minutes with Aril before leaving. The departure briefing (G7) is named the **five-minute plan**. |
| 2026-10-21 | T-128 and T-132 stay out of 0.8.1. |
| 2026-10-21 | The experiment 2 targets are accepted: a median owner time per pull request below 20 minutes, and no pull request without the proof that its repository requires. |
| 2026-10-21 | The version order and the plan placements are accepted. |
| 2026-10-21 | Closeout reconciliation (G17) joins the roadmap: one place that compares merged pull requests, open sessions, and tasks still in Review. It needs its own debrief before design. |
| 2026-10-21 | Scorecard values stay in the desktop, for now. Release notes, **What's new**, and public documents show no scorecard values. |
| 2026-10-21 | The task outcome record (G1) is stored locally, in SQLite. |
| 2026-10-21 | 0.8.1 includes #269. #270 goes to 0.9.0. |
| 2026-10-21 | The dependency proposal (G10) is accepted as a starting point. It will change, and it must adapt to each user's repositories and way of working, not only to the owner's. |
| 2026-10-24 | The [sessions inside Pomegr](embedded-terminal.md) plan is accepted with its architecture: a Terminal tab for every session, read-only history with live updates, and Continue. Its read-only history and its spike start alongside 0.9.0; the terminal stays inside G14. |

## Purpose scorecard

The scorecard shows whether Pomegr gives the owner time back. It uses the owner's normal attended work, not only experiments.
Every measure is a heuristic proxy with its sample size beside it. Owner time is never measured directly.
A measure with no source yet shows "no data"; that is an honest state, not zero.

| Measure | Definition | Source |
| --- | --- | --- |
| S1 Owner time per accepted pull request | Owner turns and owner-started sessions on a task after it reaches Review, and wall time from the owner's first action to merge | G1 |
| S2 First-pass acceptance | Share of tasks merged with no commit after Review | G1 |
| S3 Proof present | Share of pull requests with the proof that their repository's own template requires | G4 |
| S4 Silent failures | Tasks that stopped with no state change or report | G5 |
| S5 Manual closeouts | Merged tasks that still have a Review card, an open session, or a worktree one day after the merge | G12, G17 |
| S6 Model reasons | Share of starts with a recorded model reason | G6 |
| S7 Owner interventions during absence | Grants revoked or reset, and needs-you items | Pilot journal and inbox |

The first pilot is the baseline. The desktop computes its values from the sources of the retrospective. S2 compares each pull request's final commits with the head that the pilot opened, so its count is an inference from commit lists.
The scorecard lives in the desktop only. The desktop computes it from G1 and keeps a local snapshot for each version, with its formula version, so it can show each value before and after.
Release notes, **What's new**, and this roadmap may name the measure that a version targeted, but never its values. [Metrics](../architecture/metrics.md) holds the definitions.

## Versions

### 0.8.1 without the pilot

Shipped on 2026-10-21 from `release/0.8.1`, with the procedure recorded in [desktop releases](../operations/desktop-releases.md#release-from-a-release-branch).

A dry run on 2026-10-19 showed that #262 and #263 are the only pilot changes.
#260 (Aril read access) and #261 (owner-applied follow-up proposals) are ordinary Aril chat work.
The steps below gave no conflicts, and their tree equals main without #262 and #263.

1. Create `release/0.8.1` from `v0.8.0` (`a598cbde`).
2. Cherry-pick #260, #261, #264, #265, #266, #267, and #269, in that order.
3. Bump the version to 0.8.1 on the branch.
4. Dispatch `verify.yml` and `checks.yml` on the branch. They run automatically only for pull requests into main.
5. The owner validates #266 visually. Its pull request says this validation is pending.
6. Tag `v0.8.1` on the branch tip and run the release from a clean checkout of the tag. `release:windows` requires main for a new tag, so the tag is created by hand.
7. Check the generated release notes for wrong entries.
8. Record the release-branch procedure in [desktop releases](../operations/desktop-releases.md).

Main stays at 0.8.0 until its next bump, which must be 0.9.0.
A failed release burns the tag, so the CI dispatch in step 4 comes first.
T-128 and T-132 stay out.

Two changes merged after this cut was planned:

- #269 (T-163, complete tasks explicitly moved to Done) is a bug fix, and it starts worktree removal for those tasks. It enters 0.8.1 after #267, with one conflict in `server/tasks/task-report.mjs`: #262 added `dispatch_token = NULL` to the Done update. The resolution keeps the v0.8.0 update without that column. In a dry run on 2026-10-21, all 723 task server tests passed.
- #270 (calm task modal, tags from brackets) changes 86 files. It is a feature, so it goes to 0.9.0.

Step 3 replaces board task T-155, which bumps the version on main.

### Small versions after 0.8.1

Each version ships one small change and names the scorecard measure it must move.
The first version ships the scorecard itself, because no later version can show progress without it.
The owner accepted this order on 2026-10-21. Version numbers after 0.9.0 are illustrative.
The parts of other plans in the third column follow the accepted placements in [Other plans](#other-plans).

| Version | Change | Gaps and plan parts | Measure it must move |
| --- | --- | --- | --- |
| 0.9.0 | The task outcome record, the model evidence fix, and the scorecard with the first pilot as baseline. The **Aril pilot** panel goes. | G1, G2, G16 | The scorecard turns from no data to measured |
| 0.9.1 | Worktree removal after merge; closeout hints for merged tasks; dead sessions become stalled; block reasons are retained | G5, G12, G17 after its debrief | S5 manual closeouts, S4 silent failures |
| 0.9.2 | Proof presence, repository compliance checks, and a task prompt that points to the repository's own definition of done | G3, G4; guidance impact tasks 1–3 | S3 proof present, S2 first-pass acceptance |
| 0.9.3 | The review-ready check and the send-back session | G8, G9 | S2 first-pass acceptance, S1 owner time |
| 0.9.4 | Model calibration with a recorded reason for each start | G6 | S6 model reasons, S2 by model and type of work |
| 0.9.5 | The owner inbox and takeover | G13, G14; product expansion direction 6; the notification delivery path | S1 owner time |
| 0.9.6 | The five-minute plan, dependencies without the owner, discovery capture, and scheduling fixes | G7, G10, G11, G15 | S7 owner interventions during absence |

Each version also takes bug fixes. Each gap gets a board task when its version starts.

## Other plans

On 2026-10-19 each plan in this folder was checked for purpose fit.
A plan fits when it reduces the owner's supervision, review, or rework, or gives Aril and agents evidence they need.
Adoption and polish alone do not fit. The owner accepted the placements below on 2026-10-21. Each plan changes in its own change.

| Plan | State on 2026-10-19 | Proposed placement |
| --- | --- | --- |
| [Guidance impact](guidance-impact.md) | Design approved; no code | Tasks 1–3 in 0.9.2, after the plan's own check over recorded sessions. Park cohorts, the regression flag, and experiments. |
| [Durable session store](durable-session-store.md) | Proposed; no code | Park. G1 uses `tasks.sqlite`, so its task 2 (versioned migrations of `monitor.sqlite`) is not needed for 0.9.0. |
| [Provider notifications](provider-notifications.md) | Parts 1–5 built; owner's native OS acceptance open | Finish the acceptance and retire the plan. The inbox in 0.9.5 reuses its delivery path. |
| [Session allowance](session-allowance.md) | Design approved; no code | Park. Revisit after 0.9.4 if budgets need cost per task. Its token split by agent and model may serve G2. |
| [Mobile pairing](mobile-pairing-cloudflare.md) | Proposed; no code | Outside the roadmap. Revisit after 0.9.5: reach outside the home network would let the owner use the inbox away from home. |
| [Remote platform](remote-platform-and-orgs.md) | Proposed; no code | Park: organizations do not fit the solo-first audience. Its usage-limit backoff item (R1) is a bug-fix candidate for any version. |
| [Commercial strategy](commercial-strategy.md) | Hypotheses; no step started | Park. Rewrite it first: its paid tier for individual developers conflicts with free solo entry. |
| [Product expansion](product-expansion.md) | Index of 13 directions | Close it as an index after its directions move as listed below. Its adoption goal is not the purpose. |
| [Session receipt](session-receipt.md) | Direction chosen; no code | Park or close: a picture to share serves adoption, not proof. |
| [Information architecture redesign](ia-redesign.md) | Sessions 1–5 done; session 6 open | Outside the roadmap. Finish T10–T12 and retire it. |
| [Overview sparse state](overview-sparse-and-links.md) | Mostly built; tasks 4 and 6 open | Outside the roadmap. Ship or drop the two tasks and retire it. |
| [Session Activity panel](session-activity-panel.md) | Built; waits for deletion approval since 2026-09-09 | The owner approves its deletion. |
| [Design system gaps](design-system-gaps.md) | 10 samples open | Outside the roadmap. Its accessibility items 8a and 8b are bug fixes for any version. |
| [Sessions inside Pomegr](embedded-terminal.md) | Accepted on 2026-10-24 | Inside G14 in 0.9.5 for the terminal; its read-only history and its spike start alongside 0.9.0. |
| [Aril operator](aril-operator.md) | Proposed on 2026-10-24 | The coordinator of experiment 2: it builds on G6 to G10 and G13 and adds the standing grant, Aril settings, a repository memory, event wake-up, the reviewer session, and merge. The owner answered its open decisions on 2026-10-25; placement waits for the owner's review. |

Product expansion directions:

- **Into the roadmap:** 6 control tower (the inbox, in 0.9.5); 7 changes by agent (evidence for G3 in 0.9.2 and for G10 in 0.9.6); 9 compare runs (guidance impact tasks 1–3, in 0.9.2); 13 the agent reads its own metrics (the `list_session_agents` fix, in 0.9.0).
- **Park:** 4 durable store, because G1 does not need it; 1 limit movement per session; 2 plain-sentence explanations; 8 limit forecast, after 0.9.6; 10 subagent return, after G2; agent blame; the export feed.
- **Close:** 3 session receipt; 5 search across past sessions; 11 weekly digest, which the scorecard replaces; 12 chart library.

### Conflicts to resolve

- `commercial-strategy.md` proposes a paid tier for individual developers. The owner decided that solo entry stays free.
- `product-expansion.md` calls direction 13 shipped, but `list_session_agents` fails for every session.
- `product-expansion.md` says adoption matters as much as features. This roadmap puts the purpose first.
- `guidance-impact.md` says Pomegr never parses repository prose. That rule stays for Pomegr Core. Aril reads repository rules and labels its reading as an inference.
- `guidance-impact.md` experiments inject repository-authored text into sessions. They stay parked.
- `mobile-pairing-cloudflare.md` and `remote-platform-and-orgs.md` describe the phone as read-only. The phone already starts sessions and applies Aril proposals.
- `overview-sparse-and-links.md` says no code is written, but most of it is built.
- The board feature "Aril 0.9.0" and the pilot procedure name the pilot 0.9.0. This roadmap uses 0.9.0 for the scorecard.

## What is missing

Each gap names what to build, what to reuse, and the evidence that closes it.
Pomegr Core collects facts deterministically. Aril makes inferences and labels them as inferences.

### Evidence that Pomegr collects

| Gap | What is missing | Reuse | Closed when |
| --- | --- | --- | --- |
| G1 Task outcome record | For each task: pull request and state, CI on the merged head, commits after Review, owner turns in sessions of the task after Review, time from Review to Done, and requeues. Counts and times only. | Session events (`pull_request_opened`, `commit_observed`, `user_message` times) and task checks. Stored locally in SQLite. The store is `tasks.sqlite`, because the record belongs to the task control plane and observation must not depend on tasks. G1 adds two tables, `task_events` and `task_outcomes`, and creates each one when it is missing. The schema version stays 1, as for the store's earlier additive changes, so an earlier app can still open the store. | The record exists for every task, and the numbers of the retrospective are reproducible from it |
| G2 Model evidence for each agent | Requested and observed model and effort for the main agent and for each subagent, bound to the task and its type of work | #267 model retention; the agents contract | `list_session_agents` works, and every task session shows both values |
| G3 Repository process compliance | Deterministic checks that the repository declares; Core never parses repository prose. Aril reads the repository's own rules and labels its reading as an inference. | Compliance checks in the [guidance impact plan](guidance-impact.md) (task 2) | Aril reports met, unmet, or unknown for each repository rule before Review |
| G4 Proof presence | Whether the pull request has the images and sections that the repository's own template requires, and CI on its head. Presence only, never quality. | Repository snapshot and pull-request facts | A pull request without the required proof cannot look ready |
| G5 Session and task health | A dead session with uncommitted work becomes stalled with a reason. Block reasons are retained. | Stalled-task recovery (T-112); synthetic T-3 coverage verified on 2026-10-25 | [Node regression](../../../tests/server/tasks/task-stalled-recovery.test.mjs): confirmed end, dirty tree, no report, persisted Stalled state, and Tasks home attention. [UI regression](../../../tests/ui/task-stalled-recovery.test.tsx): visible reason from a synthetic board projection. S4 wiring remains open. |

Proof and privacy: Pomegr is a public repository. A pull request there must not show private session data. Clapline and Pokrr are private, so real-data proof is allowed by their own rules.

### Decisions that Aril makes

| Gap | What is missing | Closed when |
| --- | --- | --- |
| G6 Model calibration | Aril chooses each task session's model from the type of work and from G1 and G2 outcomes. With no evidence, it does not choose the cheaper model. It moves to a cheaper model only when outcomes show equal quality. An owner correction applies at once and is recorded as a data point. No model allowlist is typed by hand; the owner sets budgets and may exclude models. | Every start has a recorded reason that cites evidence or the no-evidence rule |
| G7 Five-minute plan | The departure briefing. Before the owner leaves, Aril checks each selected card. It checks the delivery path (push and pull request), the repository's proof recipe, dependencies, and decisions only the owner can make. It asks all questions in one batch. | The Pokrr cards of the first pilot are flagged in a replay |
| G8 Review-ready check | Before a task reaches the owner, G3 and G4 pass, or Aril sends the task back with reasons | No task reaches Review with unmet repository rules unless Aril states why |
| G9 Send-back | A follow-up session for the same task, in the same worktree, starts from a brief of what failed. This stays inside the current dispatch boundary because it starts a new session. Managed messages to a running session stay deferred. | A synthetic task with missing proof goes back and returns with proof |

### Work flow

| Gap | What is missing | Closed when |
| --- | --- | --- |
| G10 Dependencies without the owner | Each dependency states its kind. An order dependency is satisfied when the parent passes the review-ready check (G8). A code dependency starts from the parent's branch only where the repository's rules allow stacked pull requests; otherwise it waits for Done. After the parent merges, an agent rebases the child. Aril proposes the kind in the five-minute plan. Each brief lists sibling branches and shared resources, such as migration numbers. This is a starting point: it adapts to each user's repositories and way of working. | A replay of the Clapline chain needs no owner action between tasks |
| G11 Scheduling defects | Quota waits never consume decision rounds. A task that the grant cannot reach is reported when the grant starts. A worktree starts from a commit that exists on the remote. | Each case of findings 5 and 6 has a synthetic test |
| G12 Worktree cleanup after merge | Verify the cause of finding 9. Start the removal when the task's pull request is merged, not only after **Mark done**. Never remove uncommitted work. Show why a worktree is kept, for example a folder in use. | No merged task leaves a worktree that needs manual removal |

### Owner surfaces

| Gap | What is missing | Closed when |
| --- | --- | --- |
| G13 Owner inbox | An ordered list of owner actions only. Each item has one action, its reason, an estimated time, and a link to the proof. The item that unblocks the most work comes first. | The board needs no reading beyond the inbox to know what to do |
| G14 Takeover | One action opens a new terminal titled with the task and pull request, in the task's worktree. The session starts from a brief: goal, pull request, proof, open comments, decisions, and a link to the old session. | The owner reaches any task's work in one action |
| G15 Discovery capture | Agents record unrelated discoveries in a findings list without asking the owner. Nothing becomes a task automatically. | No session waits for an answer about an unrelated discovery |
| G16 Pilot panel replacement | The rejected **Aril pilot** panel goes. Its controls move to the five-minute plan and the inbox after a design pass. | The panel is removed |
| G17 Closeout reconciliation | One place that compares, for each task, its pull request (open, merged, or closed), its sessions (open or ended), its board state, and its worktree. It shows hints, such as "pull request merged; task still in Review; session still open". Today the owner checks each window by hand. An action for all merged tasks at once comes only after the debrief. Pomegr never closes a session; it only names the sessions that the owner can close. | After a merge, the owner closes out every merged task from one place |

## Readiness for experiment 2

The owner may start experiment 2 only when all of these are true:

1. G1 and G2 exist for every task session in the three repositories.
2. A replay of the first pilot, with synthetic fixtures, detects findings 3 to 6 before any task reaches Review.
3. During supervised work, at least 10 tasks pass the review-ready check, and the owner records agreement or disagreement with each verdict. The number 10 is a proposal.
4. Every start has a recorded model reason.
5. The inbox shows only owner actions, and the pilot panel is gone.
6. Claude is configured for the coordinator and for the task sessions.

Experiment 2 measures the scorecard values during the owner's absence, and the number of pull requests delivered. The values stay in the desktop; this roadmap records only whether each target passed.
Its targets are a median owner time per pull request below 20 minutes, and no pull request without the proof that its repository requires.

## Retrospective of the first pilot

The evidence comes from read-only reads on 2026-10-19: the pilot journal, the task store, the session history stores, and the GitHub pull requests of each repository.
Times are UTC.

### What ran

The pilot ran 10 grants on 2026-10-18 and 2026-10-19 and made 14 starts.
Every grant used Codex GPT-6 Luna for Aril's own decisions.

| Repository | Grants | Starts | Result |
| --- | --- | --- | --- |
| Clapline (private) | 4 | 8, plus 1 uncertain | Pull requests #868–#875, reviewed by the owner one after another. #876 and #877 came from later owner starts. |
| Pomegr (public) | 3 | 4 | Pull requests #264–#267; owner spot checks |
| Pokrr (private) | 3 | 2 | No pull request |

After the pilot, owner actions still remained on the Clapline and Pokrr boards.

### Where the owner's time went

1. **A person chose the model, not Pomegr.**
   The pilot form starts empty, so the owner typed the allowed models by hand.
   The Clapline grants allowed only Sonnet 5.5 and GPT-6.1-sol, so Opus was never an option.
   The main agent of each session always ran the requested model, so dispatch worked.
   The repository harness chose the subagent models: Clapline's catalog runs implementers on Sonnet, and two review agents inherit the model of their parent.
   An unset effort let Claude run at `xhigh`.
   Pomegr recorded no outcome for each model, so there was nothing to calibrate from.
2. **The repository's own process was skipped.**
   Clapline requires red-team review, blind cold review, architecture reviewers, and a pull-request template. None of them ran.
   Codex review found issues across #869–#874, some of them P1.
   Pomegr's fixed task prompt (`server/tasks/task-dispatch.mjs`, `buildTaskPrompt`) defines done as the **Complete when** checks. It does not point to the repository's own definition of done. This may have let sessions stop early; it is not proven.
3. **Proof was missing.**
   In Clapline, few visible changes had a screenshot, each of one Mock state, with no before and after.
   In Pomegr, no pull request had a screenshot. #266 was merged with "Owner visual validation is pending" in its body.
   Clapline CI runs only when a pull request opens, so the merged heads of #869–#874 have no CI result.
   Each repository already had the tools to make the proof.
4. **Dependencies waited for the owner.**
   A task that runs after another task waits until that task is Done; Review does not count.
   Clapline tasks T-256 to T-260 waited until the grant expired.
   Sessions that ran one after another did not see each other's work. Two sessions chose the same migration number, one pull request had 3 rebase conflicts, and four pull requests fixed the same edge cases.
5. **The cards did not say how to deliver.**
   The Pokrr cards checked a clean tree, a commit on the branch, and owner validation, but not a push or a pull request.
   "Open a pull request" was only in the grant objective, and the objective never reaches a task session.
   T-2 left a commit on a local branch. The worktrees started from an unpushed local branch.
6. **Failures stayed silent.**
   The Pokrr T-3 session ended with uncommitted work, and the task never became stalled.
   Pokrr T-1, T-4, and T-5 were queued while the queue was off. The pilot starts only tasks that are not queued, so they never started, and no needs-you item said so.
   One Pokrr grant used all 20 decision rounds on quota waits before the quota reset.
7. **The owner watched the pilot.**
   The owner revoked most grants, after failed inferences, needs-you items, an uncertain start, and the dirty-root gate.
8. **Pomegr's own evidence had gaps.**
   `list_session_agents` returned "malformed observation" for every session.
   The block reasons of Pomegr T-151 and T-140 were not retained.
   Pomegr records no review outcome and no owner time.
9. **The owner removed worktrees by hand.**
   Automatic removal runs only after **Mark done**, and a merged pull request does not mark a task done.
   Removal also keeps a worktree with uncommitted changes, with commits that exist nowhere else, or with a folder in use, such as a running app. It retries silently.
   The cause in this pilot is not verified. Branch deletion on merge is off in all three repositories, and the remaining local Clapline task branches match their remote branches.
10. **Earlier tracker findings.**
    The conversation of a task is hard to find among many terminals.
    Resuming an old, long conversation costs context and time.
    Agents ask whether to create a task for an unrelated discovery while the owner is away.

GitHub events give the time from the owner's first action to merge for #869–#874. That the owner spent this time on manual testing is an inference.

## Deferred ideas from the first proposal

The 2026-10-17 proposal held these ideas. They are outside the versions in this roadmap. Each needs its own plan before work.

- A global Aril across projects that resolves "in app X, fix Y" without a project selector.
- Linked human-decision tasks, so a decision holds only the work that depends on it.
- Managed messages to a running task session, with receipts.
- Three-layer memory: working context, durable scoped records, and Pomegr's operational facts. References: [LangGraph](https://docs.langchain.com/oss/python/concepts/memory), [Letta](https://docs.letta.com/agent-sdk/memory), [Mem0](https://docs.mem0.ai/platform/platform-vs-oss), and [Graphiti](https://github.com/getzep/graphiti).
- Committed events with durable cursors, so Aril wakes only on relevant change.
- Semantic analysis of content, only as a separate opt-in.
- A Home view of progress, owner actions, and next work.
- Positioning drafts, not approved: "Pomegr. Your projects move forward. You live."

## Open decisions

The owner answered the other decisions on 2026-10-21 (see [Owner decisions](#owner-decisions)). This one remains:

1. **Closeout debrief (G17).** A dedicated session with the owner that records the current manual closeout steps and their order before design. It also answers whether worktrees were removed before or after **Mark done**.

## Work and verification

- [x] The owner answers the open decisions (2026-10-21), except the closeout debrief.
- [ ] Hold the closeout debrief (G17).
- [x] Ship 0.8.1 with the steps above and record the procedure (2026-10-21).
- [ ] Verify the cause of finding 9 (worktree cleanup).
- [x] Verify whether #263 stops quota waits from consuming decision rounds: moot, #263 was reverted with the pilot (d66d9806); G11 keeps the requirement.
- [x] Fix `list_session_agents` "malformed observation" (0495d04f).
- [x] Verify G5's Pokrr T-3 shape in separate Node and UI suites with synthetic fixtures (2026-10-25).
- [ ] Wire the scorecard's S4 silent-failure measure; outside this G5 regression change.
- [ ] Ship 0.9.0 with the outcome record and the scorecard, with the first measured values in the desktop. Built on main: `task_events` and `task_outcomes`, the Scorecard panel, the pilot's removal, the server snapshot (T-173), and the desktop bridge (T-174); the release remains.
- [ ] Apply each accepted plan placement in that plan's own change.
- [ ] Create a board task for each gap when its version starts.
- [ ] Pass the readiness criteria.
- [ ] Run experiment 2 and record here whether each target passed.

## Continuation checkpoint

2026-10-25: G5's synthetic T-3 regression separates Node task-store coverage from UI rendering, preserving every assertion. The UI test imports no server modules. Existing stalled-task recovery needs no server fix. The test starts a task, confirms its session ended with dirty work and no report, and reopens the store. The owner sees the persisted task in Tasks home attention and the Review panel's fixed reason. S4 wiring remains open. Next action: implement S4 separately and hold the G17 closeout debrief.

2026-10-19: the retrospective is complete, from read-only evidence. The 0.8.1 cut was tested in a disposable worktree with no conflicts. Each other plan was checked for purpose fit. The Portuguese proposal and its attachments were replaced by this roadmap. Next action: the owner reviews this roadmap and answers the open decisions.

2026-10-21: the owner accepted the five-minute plan, the experiment 2 targets, the version order, and the plan placements, and kept T-128 and T-132 out of 0.8.1. Closeout reconciliation became G17. A dry run put #269 on the 0.8.1 cut with one resolved conflict. The owner also decided that scorecard values stay in the desktop, that G1 is stored locally in SQLite, that #269 enters 0.8.1 and #270 waits for 0.9.0, and that the dependency proposal is a starting point that adapts to each user. Next action: build `release/0.8.1`; the owner gives the go for its push, tag, and release, and schedules the closeout debrief.

2026-10-21, later: 0.8.1 shipped from `release/0.8.1`. Both checks passed on the branch, the release workflow passed, and the release description lists the included pull requests. The baseline values were removed from this roadmap at the owner's request; the desktop will show them. Next action: the owner holds the closeout debrief, and 0.9.0 starts.

2026-10-25: a read-only triage of every plan found 0.9.0 built on main but not released, and these checkboxes stale; they now match the code. The [Aril operator](aril-operator.md) plan was proposed for the coordinator of experiment 2. Next action: the owner gives the go for the 0.9.0 release and holds the closeout debrief.
