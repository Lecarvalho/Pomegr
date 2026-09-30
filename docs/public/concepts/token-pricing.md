---
title: "Token pricing"
description: "Learn how providers price cached input, uncached input, and output tokens, how that differs from a subscription allowance, and what Pomegr's API list-rate estimate is."
---

# Token pricing

When you pay a provider's API by usage, each token category has its own rate per
million tokens: a cache read costs a fraction of ordinary input, a cache write
can cost more, and output has its own rate. A subscription plan works differently:
it gives you an allowance, not a per-token charge. Pomegr does not calculate a
price from a session's token counts. Its only cost figure is Claude Code's own
**API list-rate estimate**, which is not a bill.

Prices on this page were checked on 2026-09-30 against the provider pages cited
beside them. Providers change prices, so use those pages for current rates.

## Compare cached with uncached input

Each of the four labels in
[Context and tokens](context-and-tokens.md#the-four-token-labels) has its own
rate. Take the price of the same number of ordinary input tokens on the same
model as 100%. These percentages apply to that input category, not to the whole
request:

| Provider and models | Input category | You pay | Compared with ordinary input |
| --- | --- | ---: | --- |
| Any | Uncached input | 100% | Baseline |
| Claude, most models | Cache read | 10% | 90% less |
| Claude Opus 5.5 | Cache read | 5% | 95% less |
| Claude Fable 5.1, Mythos 5.1 | Cache read | 2.5% | 97.5% less |
| Claude | Five-minute cache write | 125% | 25% more |
| Claude | One-hour cache write | 200% | 100% more |
| GPT-5.6 and later, such as GPT-5.6 Sol, Terra, and Luna | Cache read | 10% | 90% less |
| GPT-6.1 Sol | Cache read | 5% | 95% less |
| GPT-5.6 and later | Cache write | 125% | 25% more |

Sources, checked 2026-09-30: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching),
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences),
and [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Both
providers state these multipliers.

A 125% write rate is the total rate for those written tokens, not an extra 125%
on top of ordinary input; count them once. OpenAI models before GPT-5.6 have no
additional cache-write charge. Output costs its model's output rate whether or not
caching is used.

## Work through a request

Charge each category separately, then add them. For each one:

```text
Category charge = Tokens in that category × Price per million ÷ 1,000,000
```

These numbers are illustrative, not from a session. Take Claude Sonnet 5.5 at
$2 per million ordinary input tokens, $0.20 per million cache reads, $2.50 per
million five-minute writes, $4 per million one-hour writes, and $10 per million
output tokens (checked 2026-09-30 on the
[Claude price list](https://platform.claude.com/docs/en/about-claude/pricing#model-pricing)).
Each scenario has 100,000 input tokens and 2,000 output tokens. In the cache
scenarios, 90,000 input tokens are read or written and 10,000 stay uncached.

| Scenario | Input charge | Output charge | Request charge | Versus no cache |
| --- | ---: | ---: | ---: | ---: |
| No cache | $0.2000 | $0.0200 | $0.2200 | 100% |
| 90,000 tokens read | $0.0380 | $0.0200 | $0.0580 | 26.4% |
| 90,000 written for five minutes | $0.2450 | $0.0200 | $0.2650 | 120.5% |
| 90,000 written for one hour | $0.3800 | $0.0200 | $0.4000 | 181.8% |

The read row is (90,000 × $0.20 + 10,000 × $2) ÷ 1,000,000 = $0.038 of input,
plus $0.02 of output. That request pays 26.4% of the no-cache charge, but it
leaves out the earlier charge for creating the cache, so it is not a saving
across the cache's lifetime.

## When caching pays off

Caching helps when the same substantial beginning of a request is reused while
the entry is still available. For one unchanged prefix, written once and fully
read on every later request:

- With a 125% write and 10% reads, one later read is enough: 135% against 200%
  for two uncached uses, or 67.5%.
- With a 200% write and 10% reads, one later read costs 210% against 200%. Two
  later reads cost 220% against 300%, or 73.3%.

[Anthropic's guidance](https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching)
matches: caching pays off after one read for a five-minute write and two for a
one-hour write. A one-off request, a prompt whose beginning changes every
time, or a prompt shorter than the model's caching minimum
([Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))
may never repay a write. Compare lifetimes before
paying for the longer one: if a five-minute entry would still be reusable, an
hour adds no read discount. See
[Cache reuse](cache-reuse.md#cache-lifetime-and-elapsed-time) for how Pomegr
shows lifetimes.

Pomegr has no cache on/off switch. Your coding tool or the provider API controls
caching.

## API prices and subscription allowances

| | API pricing | Subscription allowance |
| --- | --- | --- |
| How you pay | Per token, at the rates above | A plan fee; usage counts against plan limits |
| Claude Code | With `ANTHROPIC_API_KEY` set, API charges apply instead of the plan | Paid plans include it and share one usage pool with Claude chat |
| Codex | With an API key, you "pay for Codex usage based on API pricing" | Included in ChatGPT plans; use depends on model, task size, and local or cloud |

Claude plans limit usage on a rolling five-hour session window, and paid plans
add weekly limits. Sources, checked 2026-09-30:
[Claude plans](https://claude.com/pricing),
[Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan),
and [Codex pricing](https://developers.openai.com/codex/pricing). An allowance is
not measured in tokens, so the price table does not convert into a percentage of
one. Provider-reported allowance use is on
[Usage limits](usage-limits.md).

## What Pomegr shows

With Claude Code local usage enabled, the Overview **Cost** panel shows "Claude
Code API list-rate estimate" and the note "Estimate, not a bill." Claude Code
calculates the figure at standard API list rates and Pomegr shows what it
recorded, so it can differ from an actual API bill and is not the marginal cost
of subscription usage. Without local usage the panel does not appear, Codex
sessions have no estimate, and **Settings → Data display** can hide it. See
[Signals and estimates](signals-and-estimates.md#agent-reported-progress-and-signals).

## Limits

- **Standard prices only.** The examples exclude taxes, Batch discounts, fast
  modes, tool fees such as web search, Claude's 1.1x US-only inference
  multiplier, and OpenAI's 10% regional-processing uplift for models released on
  or after March 5, 2026. Each provider's price page lists its other tiers.
- **No calculated cost.** Pomegr does not reconstruct a bill, a cache saving, or
  allowance use from token counts, so a hand calculation from them can differ from
  the estimate.
