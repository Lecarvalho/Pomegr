# Product expansion: making Pomegr more attractive to developers

> Status: proposed; a record of the product owner's review on 2026-09-30. Nothing here is approved for building except where a linked plan says so.
> Created: 2026-09-30.
> Scope: the directions discussed for widening Pomegr's appeal to developers, what each needs first, the decisions only the owner can make, and the order suggested. Each direction that goes ahead gets its own plan; this page is the index and the decision list.
> Continuation owner: the product owner for the decisions; the agent that picks up a direction writes its plan.
> Authority: working proposal. [PRODUCT.md](../../../PRODUCT.md), the [product positioning decision](../decisions/product-positioning.md), and `AGENTS.md` govern what is accepted. The [commercial strategy plan](commercial-strategy.md) owns editions, pricing, and buyers.
> Next task or decision: the owner settles the decisions listed under [Decisions for the owner](#decisions-for-the-owner), starting with the order of work.
> Completion criteria: every direction below is either covered by its own plan, shipped, or explicitly dropped, and the accepted positioning wording is in `PRODUCT.md`.
> Permanent destinations: `PRODUCT.md` (accepted positioning), a decision record for each contract change, and each direction's own plan and public guide.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## What the owner said on 2026-09-30

- Pomegr is a collector plus a dashboard for coding agents. Frame it around coding agents, not around AI metrics in general.
- No Elasticsearch. A durable store in SQLite is the direction; DuckDB is possible if analytics needs it.
- The rules against cumulative token spend and cost totals were an early scoping choice, not a permanent limit. The same goes for keeping transcript content out of the app. The owner is open to both to attract users.
- People may not be comfortable sharing a cost figure in dollars.

`AGENTS.md` and the [product positioning decision](../decisions/product-positioning.md) still state the spend and content limits as rules. Until those change, they govern. Each direction below that crosses one names the change it needs.

## Positioning

Pomegr's advantage is the collecting, not the charts: it reads Claude Code and Codex sessions locally and puts them in one shape (agents, cache behavior, file changes, context). Keeping those adapters working as provider formats change is the recurring cost, and the moat.

Suggested one-line pitch, not yet accepted: the tool that knows what your coding agents did, with good charts on top.

The comparison below came from an assistant's recollection during the review and was not checked against sources. Verify each line before relying on it (see the first task).

| Alternative | Where it overlaps | What it lacks |
| --- | --- | --- |
| A telemetry collector with Grafana or Kibana | Counters over time: tokens, cost, sessions, tool calls | Knowledge of the agent tree, cache refills, or which agent changed a file; needs setup |
| Tools that trace applications calling model APIs | Little today; their core is a viewer of prompt and response content | Reading of coding-agent sessions |
| Small tools that total tokens and cost from local transcripts | Spend totals | Everything beyond spend |
| The providers' own usage views | Usage, cost, session insight | A view across providers, and depth |

The providers are the most dangerous: they own the data and can ship first-party analytics at any time.

## Directions

| # | Direction | What a developer gets | Needs first | State |
| --- | --- | --- | --- | --- |
| 1 | Where did my limit go | Points of the account window per session, and tokens by agent and model inside a session | Contract changes in its plan | [Session allowance plan](session-allowance.md), design approved, revised 2026-09-30 |
| 2 | Why was this session expensive or slow | Each existing signal (cache refill, context drop, repeated calls) as one plain sentence with a fix, for example "You paused 70 minutes; the next request re-sent the whole context" | Copy and placement design | Idea; no plan |
| 3 | Session receipt | A calm picture of one session to post | Nothing | [Session receipt plan](session-receipt.md), direction chosen |
| 4 | Durable store | Restarts that do not re-read transcripts; history that lasts | Nothing | [Durable session store plan](durable-session-store.md), proposed |
| 5 | Search across past sessions | "Where did I solve this before?" | Direction 4 and the content decision below | Idea; no plan |
| 6 | Control tower for parallel sessions | "Which of my sessions needs me?" as the first screen, on desktop and phone | A design pass on the Sessions page | Idea; the needs-input and phone views exist |
| 7 | What did the agents do to my repository | File changes by agent as a review aid before a pull request | Nothing in the monitor | Idea; file-change history exists |
| 8 | Limit forecast | "At this pace the 5-hour window fills at 15:40", for the user and, through the MCP tools, for the agent | The settled samples from direction 1 | Idea; no plan |
| 9 | Compare runs | Whether a skill or instruction change helped | Its own staging decision | [Guidance impact plan](guidance-impact.md), design approved, under review |
| 10 | Subagent return | Which subagent types use context for little result | Nothing | Idea; builds on the shared-file and broad-change signals |
| 11 | Weekly digest and weekly picture | A Monday summary: windows hit, top sessions, top causes of waste | Direction 4 | Idea; no plan |
| 12 | Chart library and user dashboards | Predefined charts, then custom ones | Direction 4 and a curated list of allowed measures | The owner's backlog card; no plan |
| 13 | The agent reads its own metrics | An agent that checks its context and limits and adapts | Nothing; the MCP tools exist | Shipped; not yet presented as a selling point |

Two more ideas sit outside this repository:

- **Agent blame.** A log, pushed with a pull request, of which agent changed which lines in which session, with an editor view like Git blame. The owner raised it on 2026-09-30. Pomegr could be one producer of that log. Hard parts found in discussion: Pomegr records files, not lines; shell commands change files without saying which; lines move under human edits, rebases, and squash merges; and code hosts will not read the file without a bot or extension.
- **Export for an existing dashboard tool.** An optional feed for users who already run one, instead of making such a tool Pomegr's store.

### Suggested order

1. Session receipt. It depends on nothing and gives users something to share.
2. Session allowance. Spend is the first question developers ask.
3. Plain-sentence explanations. This is what no alternative has.
4. Durable store, then the directions that need history: weekly digest, search, charts.

Adoption matters as much as features: one command to start, no account, and something worth posting.

## Decisions for the owner

1. **Order of work.** Accept or change the order above.
2. **Spend and cost totals.** The exact `AGENTS.md` wording that allows them. The session allowance plan's first task drafts the part it needs.
3. **Transcript content.** The positioning decision lists "selling raw transcript storage or prompt surveillance" as a rejected alternative. Showing a user their own content on their own computer is a different thing, but it still needs a new decision record that supersedes the old boundary. Proposed limits if it goes ahead: opt-in, same computer only, never over the local network or in reports, and a stated answer on whether Pomegr stores content or reads it from the transcript on demand. Storing it changes what a copied database file reveals.
4. **Guidance impact staging.** See the review section in that plan.
5. **Sidecar retention.** Recorded Git snapshots are now kept up to a fixed 2,000 files. Decide whether they should follow the storage retention setting instead.

## Work and verification

- [ ] Verify the positioning table against primary sources and date each fact, or remove it. Also verify the recollection that Claude Code deletes transcripts after about 30 days by default; if true, "Pomegr keeps your history" is a selling point for direction 5.
- [ ] Record the owner's answers to the five decisions, with dates.
- [ ] For each direction that goes ahead, write its plan from the [template](../../STYLE_GUIDE.md#page-templates) and link it in the table.
- [ ] Move the accepted positioning wording into `PRODUCT.md`.

## Continuation checkpoint

2026-09-30: directions listed after the owner's review. Plans written the same day: durable session store and session receipt; the session allowance plan was revised. Next action: the owner's decisions, starting with the order.
