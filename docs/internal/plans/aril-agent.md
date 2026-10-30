# Aril agent: one standing agent that works as settled with the owner

> Status: accepted; the owner set the direction and the interface on 2026-10-28, merged the plan, and answered its open questions the same day.
> Created: 2026-10-28.
> Scope: replace the time-boxed grant with one Aril that the owner turns on or off in **Settings** and that acts exactly as settled with the owner in conversation; Aril takes the first step with a new user and a new repository; Aril talks briefly, with quick replies; the chat panel, the composer, and Home change to match. It reuses the shipped actions of the [Aril operator plan](aril-operator.md) instead of redefining them, and it absorbs the front door plan: the one Aril in Settings routes each message to the right repository.
> Continuation owner: the product owner decides; the agent that builds a phase records its evidence in the checkpoint.
> Authority: working plan. `AGENTS.md`, [Agent chat](../architecture/agent-chat.md), [Tasks](../architecture/tasks.md), [DESIGN.md](../../../DESIGN.md), and the [agent chat](../design/agent-chat.md) and [Home](../design/home.md) design pages govern shipped behavior until each phase changes them.
> Next task or decision: phase 1, the panel, the composer, and one thread for each repository; it needs no new authority.
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
| 2026-10-28 | Each repository is one continuous conversation with Aril, with search; there is no conversation list. |
| 2026-10-28 | When a repository's conversation outgrows what a run can carry, Pomegr notices and compacts the older part into a summary instead of dropping it. |
| 2026-10-28 | Typing into a session stays outside every agreement. Ending a session is allowed when an agreement covers it, and only for a task or review session Pomegr started; never a session the owner started. |
| 2026-10-28 | An agreement applies to the repository it was settled for, unless the owner says it holds everywhere. |
| 2026-10-28 | Settings › Aril is the one Aril of the former front door plan: the owner talks to one Aril, and it routes each message to the right repository. That plan is folded in here and deleted. |
| 2026-10-28 | On a paired phone, the docked panel opens as a full-screen sheet, and the phone gets the new Home. |
| 2026-10-28 | A repository's thread has no cap: it never refuses a message for being full. Settings › Aril shows how much space each repository's thread takes and gets an action that flushes the oldest messages to get space back. |
| 2026-10-28 | Marking a task Done ends the sessions Pomegr started for it; a working one only after the owner confirms, and a grant never ends a working one. |
| 2026-10-29 | "Starting…" on every message reads as a new session from scratch. Pomegr pre-warms Aril's next run instead of keeping one process open: the owner chose pre-warm over an always-open process, which would grow its own context, hold stale board facts, and bypass Pomegr's compaction. A warm run closes when idle, not when the tab or panel closes. |

## The switch

- **Settings › Aril** holds one **On/Off** switch, the owner's memory, each repository's memory, and the agreements.
- Off takes effect at once, on the desktop and on a paired phone. Aril starts, sends back, merges, ends, and writes nothing more; running sessions continue.
- Only the owner turns Aril on. Aril can pause itself, and resume after its own pause, but it never turns itself on and never resumes after the owner's Off.
- Off also stops Aril's own provider runs for follow-ups; the chat still answers when the owner writes.

## Agreements

An agreement is what the owner settled with Aril about how it works. It applies to the repository it was settled for, unless the owner says it holds everywhere; Aril's restatement names the scope.

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

6. No agent, Aril, queue, or tool ever types into a session.
7. Aril ends a session only when an agreement covers it, only a task or review session Pomegr started, and with the reason in the log. It never ends a session the owner started, and it never ends one while Aril is off.

## How Aril works

- **Judgment inside the agreement.** Aril orders the work, chooses each task's model with a recorded reason, picks the branch and version steps the repository's rules and the agreement allow, watches the usage limit, retries or reroutes after a failure, asks for a second review when the first one is weak, and pauses itself when it keeps failing.
- **It asks only what it cannot decide.** A choice the agreement and the evidence settle is Aril's: it acts and reports in one line. It asks when a decision is the owner's: a new agreement, a release, a change only the owner can make, or a result that deserves the owner's review.
- **It works for the owner, too.** When only the owner can do something, Aril creates a task for the owner, says why, and keeps the rest moving.
- **It starts the conversation.** On first launch Aril introduces itself and asks how the owner would like to work. When a repository appears, Aril reads its rules and asks how to work there, offering the agreement of a similar repository as a quick reply.
- **It resumes.** After a restart Aril continues from the task-log cursor; an action performed but not logged is detected from its result and logged once, as the operator plan's failure rules say.

## Talking

- Short and clear: the answer first, in as few words as carry it; detail only on request (**Tell me more**).
- A message that only acknowledges (for example "I'll queue it soon") gets one short line and no checks. Aril flags at most one thing, and only when it needs the owner now.
- Every message shows its time: the owner's message, Aril's answer, and each activity line (merged, started, paused).
- Activity is quiet: a routine action is one line with an icon and its time, not a message.
- Questions use quick replies by default, as buttons under the question. A multiple-choice question lists options with one line each, a recommended option first, and a free answer; it is for choices that need their trade-offs shown.
- A ping (a desktop or phone notification) is only for what needs the owner. Routine progress stays in the chat. This replaces the notification for each burst of grant follow-ups.

## Interface

The owner reviewed a prototype canvas on 2026-10-28 and chose this direction:

- **Panel.** Docked on the right, full height below the header, about 520px wide, with an expand-to-page action. The header holds the name, the On state, expand, and close. The conversation-history icon and the **+** are removed; the repository choice moves from the top of the panel into the composer.
- **One thread for each repository.** The composer's repository picks the thread; older messages load as the owner scrolls up, and search finds a message in the thread. Today's saved conversations of a repository join its thread in time order.
- **Context.** Each run is a new provider conversation that carries the newest messages that fit. When the thread outgrows that, Pomegr compacts the older part into a saved summary, made by an Aril run, and the prompt carries the summary and the newest messages. The thread shows a quiet line where it was compacted, and the owner's messages stay readable and searchable in full. Agreements and memory live outside the thread, so compaction never changes them. The summary keeps what Aril concluded from the files, board, and logs it read, never the raw tool results, so a compacted thread frees that room; a run that only re-reads them later can read them again.
- **Phone.** The panel opens as a full-screen sheet; the phone gets the new Home.
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

- [ ] **1. Panel and composer.** The docked panel and its phone sheet, the borderless composer, the repository and model in the composer, one thread for each repository with search and compaction, a time on every message, and quiet activity lines. No new authority. Measure: S1, owner time per accepted pull request, through faster answers.
- [ ] **2. Quick replies and questions.** Aril's answer may carry quick replies and one multiple-choice question; the owner's choice is sent as the owner's message. Aril's prompt gets the talking rules. No new authority.
- [ ] **2a. Pre-warmed runs.** When the owner focuses Aril's composer, and after an answer arrives, Pomegr starts the next provider run with the thread's provider, model, and effort and holds it until the owner sends; the message's prompt, built as today, then goes straight in. At most one warm run per thread. It closes after 5 minutes without a send, when the provider, model, or effort changes, and when the app quits; closing the tab or the panel does not close it. A message the warm run cannot take (for example images on Codex) starts fresh as today. Read-only access, the prompt, and privacy do not change; the run is declared to the monitor while it waits, and its task-read bridge answers only once the turn starts. First step: one real probe per provider, on the cheapest model, sending the prompt 5 seconds after the start, to prove each provider does its startup work (boot, MCP connection) before the prompt arrives; a provider that waits for the prompt gets no pre-warm. Measure: the "Started" time in an answer's tooltip, and the time from send to the first words. Built for Claude Code only; the probe showed Codex waits for the end of stdin, so it gets none (see the checkpoint and [The warm run](../architecture/agent-chat.md#the-warm-run)).
- [ ] **3. Home.** The new Home, on the desktop and the phone, with the Aril line, the needs-you items, Continue, and the composer. The Aril line and the needs-you items come from each repository's task log, with no model run.
- [ ] **4. Aril in Settings.** Settings › Aril with the switch, both memories, each repository's thread size on disk, and a way to flush its oldest messages to get that space back; Aril settings move there from the Tasks page. Off stops the grant runner at once.
- [ ] **5. Agreements.** Settled in the chat, saved, listed, and edited in Settings, scoped to one repository unless the owner says everywhere; they replace the grant start, end time, and task total; Aril resumes after a restart; ending a Pomegr-started session becomes an action an agreement can allow; the `AGENTS.md` control rule, Agent chat, and Tasks change in this phase. Measure: S7, owner interventions during absence.
- [ ] **6. Pings.** Notifications only for what needs the owner; follow-ups stay in the chat.
- [ ] **7. First steps.** Aril's first conversation with a new user, and its question when a repository appears.
- [ ] **8. Wider judgment.** Ordering, versioning and branching, self-pause and resume, and a second review, each within the agreement and each with its own log entries. Measure: S2, first-pass acceptance, and S5, manual closeouts.
- [ ] **9. One Aril across repositories.** The composer's **All repositories** choice: Aril routes each message to the right repository, as in [Routing](#routing), and answers across repositories from their task logs. Measure: messages that reached the right repository without a repository change, and clarifying questions per routed message.

The operator plan's phase 8, the acceptance run, runs under an agreement once phase 5 ships.

## Routing

From the former front door plan. Phase 9 builds it; each repository keeps its own thread, board, folder, memory, agreements, and log.

- Cheap clues decide first, in this order: a repository the owner names, a repository-prefixed task ID ("Pomegr T-12"), the page the owner is on.
- Only when the clues do not settle it does a small, cheap model choose, from short repository summaries (name, open features, recent log entries). It never sees transcripts or task text beyond those summaries.
- When it is still unsure, Aril asks with quick replies (**Pomegr** · **Clapline**).
- A bare task ID such as "T-12" exists in every repository, so it never routes by itself.
- A routed message is posted in that repository's thread, and the full message goes only to that repository's run.
- An action belongs to one repository and runs under that repository's agreements.

## Open questions

These are the owner's decisions; settle them before phase 9.

1. **Mixed questions.** When a message touches several repositories, does Aril answer it from the task-log summaries, or split it into each repository's thread?
2. **Routing model.** Which small model routes, and from which provider when the owner has only one? Is a routing cost per message acceptable, or should routing stay clue-only plus the clarifying question?
3. **Summary content.** What belongs in the repository summary the router sees, and does any of it need the owner's opt-in per repository?
4. **Work across repositories.** Is coordinated work across repositories (a shared source and its hand-copied consumers) needed, or is routing enough?

## Checkpoint

2026-10-28: plan written after the owner rejected the time-boxed grant, set the standing-agreement direction, and reviewed a prototype of the panel, the composer, and Home. Next action: the owner reviews this plan and answers the open questions.
2026-10-28: the owner answered the five open questions (one thread for each repository, ending Pomegr-started sessions by agreement, repository scope by default, the front door folded in, the phone sheet and Home) and asked that an outgrown thread be compacted, not dropped, freeing the room tool results take. The front door plan is deleted; its routing rules and remaining questions are above. Next action: phase 1.
2026-10-28: phase 1, first pull request: the docked panel over a light dim, Expand, Close, the borderless composer with the repository, model, and effort (effort now reaches the run), a time on every message, quiet grant follow-up lines, and no ring on the message field. The owner tested it in the desktop app and accepted it after fixes to the model and effort controls, the overlay, the field ring, and the Jump to latest fill. Next action: the second pull request, one thread for each repository with search.
2026-10-28: phase 1, second pull request: one thread for each repository over the stored conversations, with paging, search, a send that rolls into a new conversation, no cap on conversations, and the prompt's history read across conversations. The owner tested it in the desktop app and accepted it; the owner added that Settings › Aril shows each thread's size and can flush its oldest messages (phase 4). Next action: the third pull request, compaction.
2026-10-28: phase 1, third pull request: compaction of an outgrown thread into a saved summary by a read-only run without tools, the quiet summary line in the thread, timings on each answer (started, first words, done), and two fixes the owner found (composer selects that stretched in the expanded panel, proposal numbers outside the box). The owner could not trigger a compaction in real use, and the provider's tool-less arguments are not yet proven live. Next action: the owner tries compaction on a long thread and reads the timings; phase 1 is checked only after that.
2026-10-28: phase 2, first pull request: quick replies and one multiple-choice question under Aril's answer, as a fenced `pomegr-replies` block that is read strictly and stored on the message, buttons and rows in the panel that send their label as the owner's own message (only the newest answer's choices can be tapped, and the pick is marked once the owner has answered), and the talking rules in Aril's instructions. No new authority: a choice only sends a message. A live model's use of the block is unproven. Next action: the owner tests quick replies in real use; phase 2 is checked only after that.
2026-10-29: phase 2, after the owner's first test: answers were slow and sat on "Starting…", so the label now says Starting only until the provider's first event (Thinking from then on) and the prompt was made smaller (a compact board snapshot of at most 20,000 characters, shorter instructions, about 35% fewer characters in total on a large synthetic board). Next action: the owner uses the chat again and the timings are read again before phase 2 is checked.
2026-10-29: the owner still found "Starting…" too long. The stored preparation timing showed 9.8 of 10.7 seconds in the task worktree size walks, which move to a background-refreshed cache; acknowledgments get a one-line answer; and phase 2a, pre-warmed runs, is added. Next action: build phase 2a after its probe.
2026-10-29: phase 2a built for Claude Code. The probe showed Claude Code in print mode waits about 3 s for stdin and exits ("Input must be provided"), but with `--input-format stream-json` it waits, connects its MCP server about 0.5 s after the start, and emits `system:init` 43 ms after a user message line, so every Claude turn now reads its prompt that way and a warm run starts on focus and after an answer, holds no prompt until the owner sends, and closes after 5 minutes idle. The Codex probe showed no gain: `codex exec ... -` does nothing until stdin ends and connected its MCP server about 1.9 s after the prompt arrived, so Codex gets no pre-warm. Next action: the owner uses the chat and reads "Started" in the answer tooltip, which should read a fraction of a second with "(warm)", and the time from send to the first words; phase 2a is checked only after that.
