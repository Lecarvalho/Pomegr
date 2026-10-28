# Aril agent: one standing agent that works as settled with the owner

> Status: proposed; the owner set the direction and the interface on 2026-10-28 and reviews this plan before any build.
> Created: 2026-10-28.
> Scope: replace the time-boxed grant with one Aril that the owner turns on or off in **Settings** and that acts exactly as settled with the owner in conversation; Aril takes the first step with a new user and a new repository; Aril talks briefly, with quick replies; the chat panel, the composer, and Home change to match. It reuses the shipped actions of the [Aril operator plan](aril-operator.md) and the routing questions of the [Aril front door plan](aril-front-door.md) instead of redefining them.
> Continuation owner: the product owner decides; the agent that builds a phase records its evidence in the checkpoint.
> Authority: working plan. `AGENTS.md`, [Agent chat](../architecture/agent-chat.md), [Tasks](../architecture/tasks.md), [DESIGN.md](../../../DESIGN.md), and the [agent chat](../design/agent-chat.md) and [Home](../design/home.md) design pages govern shipped behavior until each phase changes them.
> Next task or decision: the owner reviews this plan and answers the open questions; phase 1 (the panel and the composer) needs no new authority and can start after that review.
> Completion criteria: with Aril on, the owner settles how Aril works in conversation once, and Aril keeps the work moving without a grant, survives an app restart, and pings the owner only for what needs them; with Aril off, Aril does nothing; every rule below has a test; and the owner has tested each phase in real use and accepted it.
> Permanent destinations: `AGENTS.md` for the control boundary, [Agent chat](../architecture/agent-chat.md) for agreements, the switch, quick replies, and pings, [Tasks](../architecture/tasks.md) for the actions an agreement allows, [DESIGN.md](../../../DESIGN.md) and the agent chat and Home design pages for the interface, and [PRODUCT.md](../../../PRODUCT.md) for the purpose wording.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Summary

The grant lets Aril start, review, send back, merge, mark done, and write tasks, but only for a period the owner sets up each time, within a total of tasks, and only until the app quits.
The owner does not want that. On 2026-10-28 the owner asked for an Aril that is settled once, in conversation, and then works without supervision, keeps things moving, and pings the owner only with what needs them.

This plan makes three changes:

1. **One switch.** Aril lives in **Settings**, with the owner's memory, each repository's memory, the agreements, and one **On/Off** switch. Off means Aril does nothing, anywhere, at once.
2. **Agreements, not grants.** With Aril on, Aril does exactly what the owner settled with it, no more and no less. "Do nothing on my behalf" is an agreement. So is "do one thing, and ping me when each task finishes", and "run the backlog, merge on green, and ask me only about releases".
3. **Aril takes the first step.** A new user meets Aril first, and Aril asks how they would like to work. When a new repository appears, Aril reads its rules and asks how to work there. The owner talks to Aril; no one has to learn a settings page first.

## Owner decisions

| Date | Decision |
| --- | --- |
| 2026-10-28 | The time-boxed grant is not what the owner wants. Aril acts under a standing agreement that stays in force until it is paused or changed. |
| 2026-10-28 | After an app restart, Aril resumes on its own. A restart is never the reason work stops. |
| 2026-10-28 | No fixed limits beyond the provider usage limit. Aril settles the rest with the owner in conversation, not on a page. |
| 2026-10-28 | Aril manages the backlog with judgment: what runs now and what waits, versioning and branching, the model for each task, the limits, failures and how to unblock them, a second review when one is needed, and when to stop, start, or pause. It creates tasks for the owner when only the owner can do them, and it learns how the owner and each repository work. |
| 2026-10-28 | Aril pings the owner when it needs them, sends follow-ups, and asks the owner to review what deserves their attention. The aim is not to work without pause; it is for Aril to propose what can be done, and how, in a way that works for both. |
| 2026-10-28 | The owner rejects the `AGENTS.md` rule that only the owner starts a grant and that every other change needs Apply. One Aril in **Settings** holds the memory and the switch; when Aril is on, it works as settled. |
| 2026-10-28 | Aril talks just enough, and clearly. Every message, the owner's included, carries its time. Quick-reply buttons are the default for a question; a multiple-choice question is for options that each need a line of trade-off. Aril asks only what it cannot decide itself: a routine choice inside the agreement, such as moving work to another provider when one reaches its usage limit, is Aril's to make and report. |
| 2026-10-28 | This plan is critical. The owner tests each phase in real use to see whether Aril is really smarter, and the work is adjusted until it is; no phase is done before the owner accepts it. |
| 2026-10-28 | The interface: a docked Aril panel, a borderless composer with borderless buttons and the repository and the model in its bottom row, and a Home with brief information above a centered composer. |

## The switch

- **Settings › Aril** holds one **On/Off** switch, the owner's memory, each repository's memory, and the agreements.
- Off takes effect at once, on the desktop and on a paired phone. Aril starts, sends back, merges, and writes nothing more; running sessions continue, because Pomegr never ends a session.
- Only the owner turns Aril on. Aril can pause itself, and resume after its own pause, but it never turns itself on and never resumes after the owner's Off.
- Off also stops Aril's own provider runs for follow-ups; the chat still answers when the owner writes.

## Agreements

An agreement is what the owner settled with Aril about how it works, for one repository or for all of them.

- **Settled in conversation.** The owner says it in the chat. Aril restates it in one line with quick replies ("Save this agreement?" **Save** · **Change it**). The saved record is the authority.
- **Visible and editable.** Settings › Aril lists every agreement in the owner's words and Aril's one-line restatement; the owner can edit or delete each one, and Aril proposes a change when it sees one is needed.
- **No agreement, no action.** A new user or a new repository starts with none, so Aril only talks and proposes there until one is saved.
- **Only from the owner.** Aril reads repository files, plans, issues, and pull-request text, and any of them could carry instructions written to steer it. An agreement counts only when the owner said it in the chat; Aril never derives one from repository content, a task, or a session.
- Agreements replace the grant's switches, end time, task total, and work rules. The provider usage limit stays.

## The floor

These hold whatever an agreement says:

1. Agreements come only from the owner, as above.
2. Off always wins, at once, from the desktop or a paired phone.
3. The privacy rules stay: no raw prompt, response, transcript, tool content, or credential reaches the browser, and observation stays read-only.
4. Every action is one fixed, validated action, and every action, refusal, and pause is in the log with its reason.
5. A merge still needs green CI on the pull request's head and a passing review.

Typing into a session and ending one stay outside every agreement until the owner decides otherwise (open question 2).

## How Aril works

- **Judgment inside the agreement.** Aril orders the work, chooses each task's model with a recorded reason, picks the branch and version steps the repository's rules and the agreement allow, watches the usage limit, retries or reroutes after a failure, asks for a second review when the first one is weak, and pauses itself when it keeps failing.
- **It asks only what it cannot decide.** A choice the agreement and the evidence settle is Aril's: it acts and reports in one line. It asks when a decision is the owner's: a new agreement, a release, a change only the owner can make, or a result that deserves the owner's review.
- **It works for the owner, too.** When only the owner can do something, Aril creates a task for the owner, says why, and keeps the rest moving.
- **It starts the conversation.** On first launch Aril introduces itself and asks how the owner would like to work. When a repository appears, Aril reads its rules and asks how to work there, offering the agreement of a similar repository as a quick reply.
- **It resumes.** After a restart Aril continues from the task-log cursor; an action performed but not logged is detected from its result and logged once, as the operator plan's failure rules say.

## Talking

- Short and clear: the answer first, in as few words as carry it; detail only on request (**Tell me more**).
- Every message shows its time: the owner's message, Aril's answer, and each activity line (merged, started, paused).
- Activity is quiet: a routine action is one line with an icon and its time, not a message.
- Questions use quick replies by default, as buttons under the question. A multiple-choice question lists options with one line each, a recommended option first, and a free answer; it is for choices that need their trade-offs shown.
- A ping (a desktop or phone notification) is only for what needs the owner. Routine progress stays in the chat. This replaces the notification for each burst of grant follow-ups.

## Interface

The owner reviewed a prototype canvas on 2026-10-28 and chose this direction:

- **Panel.** Docked on the right, full height below the header, about 520px wide, with an expand-to-page action. The header holds the name, the On state, expand, and close. The conversation-history icon and the **+** are removed; the repository choice moves from the top of the panel into the composer.
- **Composer.** Borderless, on a raised fill, with rounded corners and borderless buttons. The bottom row holds attach, the repository, then the model and effort, and a round send action.
- **Messages.** The owner's message is a bubble with its time below it. Aril's answer starts with its name and time, then a collapsed line of what it read, then the answer. A thing that needs the owner is a small card with its links or quick replies.
- **Home.** One centered column: a greeting and one Aril line of what happened, the items that need the owner, **Continue** (the last viewed session and the pinned destinations), one quiet line with provider status and What's new, and the composer at the bottom with a few suggestions above it. The session guides and the roadmap preview leave Home.
- **Design contract.** The rounded composer, the docked panel, the round send action, and the suggestion chips are outside today's 4px and 6px radius rule and the floating-panel layout. `DESIGN.md` and the agent chat and Home design pages change first, in the phase that ships each one, with their `/design-system` samples.

## What this replaces and what stays

| Today | With this plan |
| --- | --- |
| A grant the owner starts, with an end time, a task total, and an end when the app quits | Standing agreements and one switch; Aril resumes after a restart |
| Only the owner starts a grant; each other change needs Apply | What the agreement allows needs no Apply; anything else is still a proposal the owner applies |
| Aril settings on the Tasks page | Settings › Aril |
| A notification for each burst of grant follow-ups | A ping only for what needs the owner |
| A floating 420px panel with history and **+** | A docked panel with the repository and model in the composer |

The shipped actions stay as the means: start, review, send back, merge, mark done, write tasks, the reviewer session, the merge checks, the safe worktree removal, the task log, the repository memory, and the follow-up line.

## Phases

Each phase ships on its own and names the [purpose scorecard](purpose-roadmap.md#purpose-scorecard) measure it should move before it ships.

A phase is checked only after the owner accepts it:

1. The phase merges with its tests passing.
2. The owner uses it in real work, on real repositories, and says what is still off.
3. Each finding becomes a fix in the same phase, or a task the owner agrees to defer, and is recorded in the checkpoint.
4. The owner says the phase is accepted. Green tests alone never check a phase.

- [ ] **1. Panel and composer.** The docked panel, the borderless composer, the repository and model in the composer, a time on every message, and quiet activity lines. No new authority. Measure: S1, owner time per accepted pull request, through faster answers.
- [ ] **2. Quick replies and questions.** Aril's answer may carry quick replies and one multiple-choice question; the owner's choice is sent as the owner's message. Aril's prompt gets the talking rules. No new authority.
- [ ] **3. Home.** The new Home with the Aril line, the needs-you items, Continue, and the composer.
- [ ] **4. Aril in Settings.** Settings › Aril with the switch and both memories; Aril settings move there from the Tasks page. Off stops the grant runner at once.
- [ ] **5. Agreements.** Settled in the chat, saved, listed, and edited in Settings; they replace the grant start, end time, and task total; Aril resumes after a restart; the `AGENTS.md` control rule, Agent chat, and Tasks change in this phase. Measure: S7, owner interventions during absence.
- [ ] **6. Pings.** Notifications only for what needs the owner; follow-ups stay in the chat.
- [ ] **7. First steps.** Aril's first conversation with a new user, and its question when a repository appears.
- [ ] **8. Wider judgment.** Ordering, versioning and branching, self-pause and resume, and a second review, each within the agreement and each with its own log entries. Measure: S2, first-pass acceptance, and S5, manual closeouts.

The operator plan's phase 8, the acceptance run, runs under an agreement once phase 5 ships.

## Open questions

These are the owner's decisions. Settle them before the phase that needs them.

1. **Conversation history.** With the history icon gone, is each repository one continuous thread, with search, or does history move into Settings › Aril? (Phase 1.)
2. **Sessions.** Do typing into a session and ending one stay outside every agreement? This plan assumes yes. (Phase 5.)
3. **Default scope.** Does an agreement apply to one repository unless the owner says "everywhere", or the other way round? (Phase 5.)
4. **Front door.** Is Settings › Aril the one Aril of the [front door plan](aril-front-door.md), so routing between repositories becomes part of this plan? (Phase 7.)
5. **Phone.** Does the phone get the docked panel's layout as a full-screen sheet, and the new Home? (Phases 1 and 3.)

## Checkpoint

2026-10-28: plan written after the owner rejected the time-boxed grant, set the standing-agreement direction, and reviewed a prototype of the panel, the composer, and Home. Next action: the owner reviews this plan and answers the open questions.
