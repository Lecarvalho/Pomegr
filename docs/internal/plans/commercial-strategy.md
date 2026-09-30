# Commercial strategy hypotheses

> Status: active, awaiting the first validation step. Every statement below is an unvalidated business hypothesis; none is shipped, priced, or a roadmap commitment.
> Created: 2026-08-11 as `docs/COMMERCIAL_STRATEGY.md`; split out on 2026-09-30.
> Scope: editions, pricing, target buyer, positioning wording, and the validation path for any commercial offering built around the open-source observer.
> Continuation owner: Pomegr maintainers.
> Authority: working checklist. [PRODUCT.md](../../../PRODUCT.md), the [product positioning decision](../decisions/product-positioning.md), and the [license history](../decisions/license-history.md) govern what is accepted; AGENTS.md governs privacy and product invariants.
> Next decision: whether to start the validation path below, and who runs the interviews and the demo. If commercial work is paused instead, record that here with the reason.
> Completion criteria: the first validation milestone is met (three organizations pay for a pilot and use its output repeatedly), or the hypotheses are explicitly abandoned or superseded by a decision record.
> Permanent destinations: accepted positioning wording in `PRODUCT.md`, accepted rationale in a decision record, and any shipped edition or remote feature in its own contract and public guide. The platform work has its own plans, linked below.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Accepted parts of the original document

The original `docs/COMMERCIAL_STRATEGY.md` was a working document. The statements that were decided moved out of it: the open-source core, the AGPL licensing choice, and the boundary against authoritative evaluation are recorded in the [product positioning decision](../decisions/product-positioning.md) and in `PRODUCT.md`. This plan holds only what remains to be validated.

## Hypotheses

### Commercial thesis

Pomegr can become the privacy-first operations console for teams using coding agents. Its commercial advantage is hypothesized to be useful execution visibility without collecting raw prompts, responses, commands, tool output, or source code, rather than generic AI tracing.

### Platform direction

The technical direction behind the Pro, Teams, and Enterprise hypotheses (a Pomegr-operated remote backend, native mobile apps, device pairing, coordinated usage-limit polling, and organization visibility) is proposed, not implemented. It lives in the [remote platform plan](remote-platform-and-orgs.md) and the [mobile pairing plan](mobile-pairing-cloudflare.md) and is not repeated here.

### Target customer

The initial buyer hypothesis is an engineering manager, developer-platform lead, or AI-enablement lead at a team that:

- has roughly 5-50 developers using one or more coding-agent providers;
- wants to understand agent activity, attention states, context pressure, and repository outcomes;
- cannot send private transcripts or source code to another observability service; and
- is willing to pay for team-wide visibility, alerts, retention, or governance.

### Potential editions

Edition names, contents, and prices are hypotheses. Community describes the existing open-source observer; the other editions do not exist.

- **Community.** The open-source, local observer: live sessions, local history, deterministic metrics, reports, and provider adapters.
- **Pro.** A convenience product for individual developers. Possible value includes a signed installer, automatic updates, background startup, desktop notifications, scheduled reports, extended local history, remote access from anywhere through the Pomegr backend, native mobile apps with push notifications, and coordinated usage-limit polling across a developer's machines. Initial pricing hypothesis: USD 9 per month or USD 79 per year.
- **Teams.** A shared view built from bounded, normalized metadata produced on developer machines. Raw transcripts and credentials remain local. Possible value includes a team session catalog, attention and stuck-session alerts, shared reports, retention controls, budget signals, and repository integrations. Initial pricing hypothesis: USD 15-25 per developer per month, possibly with an organization minimum.
- **Enterprise.** A self-hosted or privately managed coordination layer with SSO, role-based access, audit logs, configurable retention, deployment support, and an SLA. Initial pricing hypothesis: annual contracts starting around USD 10,000, subject to customer discovery.

### Working positioning

The working category is **privacy-first operations for coding agents**. The working one-liner is "See what your coding agents are doing without collecting prompts or source code." Neither is adopted: `PRODUCT.md` keeps its current positioning until a decision accepts new wording.

### Working non-goals to confirm

These two were listed as non-goals but are not backed by a repository invariant, so they stay open until the owner confirms them:

- Competing broadly with application-level LLM tracing platforms.
- Building bespoke provider integrations that do not strengthen the normalized core.

## Validation path

Do not build billing or a multi-tenant service before validating the buyer and the pain. The repository holds no interview, pilot, or pricing evidence for any of these steps.

- [ ] Package Pomegr so a new user can install and see value quickly.
- [ ] Publish a short demo centered on concurrent sessions, attention state, context, and Git changes.
- [ ] Interview at least 15 teams already using coding agents.
- [ ] Offer three paid, four-week design-partner engagements. A possible pilot price is USD 500-1,500 per company; the purpose is learning, not services revenue at scale.
- [ ] Manually provide a weekly privacy-bounded agent-operations report.
- [ ] Record which requests repeat across paying partners before committing to a Teams architecture.

### Evidence to seek

Strong buying signals include repeated requests to:

- see agent activity across the whole team;
- receive an alert when a session needs attention or appears stuck;
- compare projects or providers without reading transcripts;
- retain safe operational metadata for later review;
- enforce or demonstrate privacy boundaries; or
- obtain SSO, access controls, auditability, or deployment support.

The first meaningful validation milestone is three organizations paying for a pilot and using the output repeatedly. Stars, downloads, and compliments are useful distribution signals but do not validate the commercial buyer by themselves.

## Open questions

- Is the first paying buyer an individual developer, engineering manager, platform team, or security team?
- Is packaging alone valuable enough for Pro, or is team coordination the first durable paid product?
- Which normalized fields can organizations safely aggregate while preserving Pomegr's privacy promise?
- Is hosted coordination acceptable, or do target customers require self-hosting from the beginning?
- Which notification or repository integration creates the strongest recurring use?
- What usage or outcome should pricing track: developers, active machines, retained sessions, or organization size?

## Continuation checkpoint

Created 2026-09-30 by splitting the working strategy document. The accepted statements are in `PRODUCT.md` and the product positioning decision; this file holds the remainder unchanged in substance. No validation step has started. The next action is the decision named in the header.
