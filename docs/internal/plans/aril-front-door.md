# Aril front door: one chat that routes to each repository's Aril

> Status: rough draft for discussion; the open questions below are the owner's to settle with the implementing session before any build.
> Created: 2026-10-26.
> Scope: one Aril the owner always talks to (the front door), which routes each message to the Aril of the right repository, can summarize across repositories, and later coordinates work that spans repositories. Each repository's Aril keeps its own board, folder, settings, memory, grant, log, and chat, and the owner can still talk to it directly.
> Continuation owner: the product owner decides; the session that takes the task settles the open questions with the owner, then turns this draft into an accepted plan with phases.
> Authority: working plan. `AGENTS.md` and [Agent chat](../architecture/agent-chat.md) govern shipped behavior until a phase changes them.
> Next task or decision: the open questions.
> Completion criteria: the owner reaches every repository's Aril from one chat, on the desktop and on a paired phone, without picking a repository by hand, and no repository's authority, memory, or privacy leaks into another.
> Permanent destinations: [Agent chat](../architecture/agent-chat.md) for routing, the front-door thread, and its privacy; `AGENTS.md` if the control boundary changes; a page in `docs/internal/design/` for the chat surface.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Why

Today each Aril chat belongs to one repository: its board, its folder (so it reads that repository's rules, plans, and code), and its settings, memory, grant, and log. The owner picks the repository in a chooser before talking. With several repositories, and above all on a phone, the owner wants to talk to one Aril and let it reach the repository that knows the answer, while keeping the option to open one repository's Aril directly.

## Shapes considered

1. **Router.** The front door decides which repository a message is about and hands it to that repository's Aril. The answer shows in the same window, labelled with the repository, with a link into that repository's own chat. Everything else stays per repository. This is the smallest change.
2. **Coordinator.** The router, plus turns that reach several repository agents: an overview ("what happened everywhere since yesterday?") and work that spans repositories (a change to a shared source that its hand-copied consumers must follow). Each repository's part of a combined proposal applies to its own board.
3. **One global agent with every board in its prompt.** Rejected for now: the prompt grows with every repository, Aril loses the repository folder it reads code and rules from, and settled per-repository rules blur.

The draft favors shape 1 first and shape 2 later, as separate steps.

## Routing

- Cheap clues decide first, in this order: a repository the owner names, a repository-prefixed task ID ("Pomegr T-12"), the page the owner is on.
- Only when clues do not settle it does a small, cheap model choose, from short repository summaries (name, open features, recent log entries). It never sees transcripts or task text beyond those summaries.
- When it is still unsure, the front door asks ("Pomegr or Clapline?").
- A bare task ID such as "T-12" exists in every repository, so it never routes by itself.

## Draft rules

- The front door proposes and changes nothing itself. Every proposal belongs to one repository and applies on that repository's board; Apply stays per repository.
- Grants stay per repository. The front door never starts, stops, or widens a grant.
- A handoff starts or continues the repository's own thread and links both ways, so the repository's history stays complete.
- The repository's Aril runs exactly as today, in its folder, with its settings, memory, and log.
- The front door sends the full message only to the repository Aril it routed to.

## Suggested order, each step useful alone

1. **Follow the current repository.** On a repository's Tasks page, the chat is that repository's Aril and the chooser hides; Home, Sessions, and the phone keep the chooser.
2. **Owner memory layer.** Preferences that hold everywhere (for example "docs in English") live once and every repository's Aril sees them, next to that repository's own memory.
3. **Summary across repositories.** Built from each repository's task log, with no model run: what happened, what needs the owner.
4. **Router front door.** Clue routing, the small-model fallback, the clarifying question, repository-prefixed task IDs, and handoff links.
5. **Coordinator.** Overview turns and combined proposals for work that spans repositories.

Each step names the scorecard measure it should move before it ships (see the [purpose roadmap](purpose-roadmap.md)).

## Open questions

These are the owner's decisions. Settle them with the implementing session before any build.

1. **Mixed questions.** When a message touches several repositories, does the front door answer it itself from the summaries, or always hand each part to the repository agents?
2. **Handoff visibility.** Should the owner see the handoff ("asking Pomegr…") and the repository label, or should it feel like one Aril?
3. **Owner memory.** Should the owner's own preferences be a separate layer shared by every repository's Aril? The draft says yes. Who may write to it: only the owner, or Aril by proposal as with repository memory?
4. **Work across repositories.** Is it a real need now (a shared source and its hand-copied consumers), or is the router enough for the first versions?
5. **Front-door thread.** Does the front door keep its own saved conversation, or is it a view over the repository threads it routed to?
6. **Routing model.** Which small model routes, and from which provider when the owner has only one? Is a per-message routing cost acceptable, or should routing stay clue-only plus the clarifying question?
7. **Summary content.** What belongs in a repository summary the router sees (features, recent log entries, Ready and Review counts), and does any of it need the owner's opt-in per repository?
8. **Phone.** Is the phone the first surface for the front door, or does the desktop come first?
9. **One grant across repositories.** Out of scope for this plan, or a later step?
10. **Scorecard.** Which measure shows the front door saves the owner time (for example messages that reached the right repository without a chooser change, or clarifying questions per routed message)?

## Checkpoint

- 2026-10-26: rough draft from the owner's discussion of 2026-10-25; no decision recorded yet.
