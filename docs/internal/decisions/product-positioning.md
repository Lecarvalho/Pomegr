# Pomegr product positioning

> Status: accepted.
> Decided: 2026-08-11, in the commit that adopted AGPL-3.0-only and introduced the commercial strategy working document. The boundary against authoritative evaluation has been in [PRODUCT.md](../../../PRODUCT.md) since 2026-08-10.
> Scope and owner: how Pomegr is positioned against the open-source core and any future commercial offering; the product owner.
> Authority: rationale only. [PRODUCT.md](../../../PRODUCT.md) owns the current positioning, [AGENTS.md](../../../AGENTS.md) owns the privacy and product invariants, and [license history](license-history.md) owns the licensing rationale. The [commercial strategy plan](../plans/commercial-strategy.md) holds every unvalidated hypothesis.

## Decision and context

Pomegr is a local, read-only observer of coding-agent sessions. Three positioning choices were accepted:

- **The local observer stays open source and useful on its own.** Future development uses `AGPL-3.0-only`, with the option of separate commercial terms. Earlier MIT revisions remain MIT, and the name and visual identity are governed separately by the [trademark policy](../../../TRADEMARKS.md). Any future revenue is expected to come from convenience, coordination, governance, and support around that core.
- **The differentiator is bounded execution visibility.** Pomegr shows what agents are doing without collecting raw prompts, responses, commands, tool output, or source code. It is positioned on that boundary, not as generic AI tracing.
- **Pomegr is not an authoritative evaluator.** It does not judge developer or agent quality. Metrics and recommendations are deterministic signals tied to concrete execution evidence, and a heuristic is never presented as an AI judgment or an authoritative measurement.

## Alternatives and consequences

Two alternatives were recorded as non-goals and remain rejected because the privacy and metric invariants forbid them:

- Selling raw transcript storage or prompt surveillance.
- Presenting heuristics as AI judgments or authoritative performance scores.

Consequences for future changes:

- Editions, pricing, a target buyer, hosted coordination, and remote or organization features are not decided. They are unvalidated hypotheses in the commercial strategy plan, and no product page, README, or in-app copy may present them as shipped, available, or priced.
- Any shared or organization-level view must be built from normalized, bounded metadata and keep every invariant in AGENTS.md. A feature that needs a new category of data first needs its own documented contract, as AGENTS.md records for each exposed metadata family.
- A change to the open-source core, its licensing, or the evaluator boundary is a new decision that supersedes this record; link it here.
