# Cache timing

Pomegr keeps agent execution state separate from cache timing. Agent labels such
as **active**, **warm**, **idle**, and **finished** describe observed execution or
liveness evidence; they do not describe prompt-cache availability.

## Times shown for an agent

- **Last request** is the newest retained valid request snapshot for that
  normalized agent.
- **Last cache touch** is the newest retained valid request snapshot for the
  same agent with a positive cache-read or cache-write token count.

These times often match, but they do not have to. A model request can have no
reported cache activity, and a provider can omit cache details that Pomegr would
need for a cache-timing estimate.

Both values come from the bounded request-snapshot feed. They are not derived
from `Agent.lastSeen`, provider lifecycle updates, filesystem observation time,
or cumulative token totals.

A plain assistant reply counts when it carries valid request usage. A provider
summary or lifecycle event without that usage does not advance this timestamp.
For example, Claude Code records an away summary separately from an assistant
request. Recent activity is a separate feed of tool use, user input, and selected
session events. It labels recorded assistant text as **Assistant replied** and
provider away summaries as **Summary updated**, without exposing their content.
A reply can appear there even when request usage is unavailable; neither activity
label supplies missing usage or changes **Last request**.

## Lifetime indication

Pomegr evaluates a cache lifetime only when the latest cache-touch request
itself carries a resolved `5m` or `1h` lifetime:

- A five-minute lifetime enters the **nearing threshold** state during its last
  minute.
- A one-hour lifetime enters the **nearing threshold** state during its last
  five minutes.
- After the recorded lifetime passes, Pomegr reports **lifetime threshold
  elapsed**.

Outside the nearing and elapsed states, **Last request** remains ordinary
text without an underline or popover. Pomegr adds the disclosure affordance only
when it has cache timing that needs attention.

Mixed, minimum-only (`30m+`), missing, malformed, or otherwise unavailable lifetime
evidence does not produce a warning. Codex's `cache TTL ≥30m` label is a documented
model-policy minimum, not an expiry deadline; see [cache lifetime resolution](METRICS.md#cache-events).
Historical sessions show recorded request and cache-touch
times without a live warning state.

Live agents with a normalized **finished** or **stopped** status also show the
recorded last-request age as plain text without a live warning. If the same agent
returns to an active, warm, waiting, needs-input, or idle status, the live warning
is evaluated again from the retained cache-touch evidence.

An elapsed lifetime is not proof that a cache entry expired. Provider retention
can exceed a documented minimum, and cache availability can also change because
of prefix changes, routing, eviction, model changes, or a prefix that was never
written. Pomegr therefore keeps the indication amber and uses cautious wording.

## Sessions page indication

The Sessions directory carries the same evaluation for the session's **primary
agent** only, because that is the conversation a person resumes. Every row with
retained evidence, live or historical, includes the primary agent's newest
cache-touch time and its allowlisted lifetime (`SessionSummary.cacheTiming`); the
browser evaluates the state against its live clock, so a row changes without a
new catalog revision. Historical rows keep the evidence because a resumed session
still depends on that cache.

- Within the lifetime, the row shows nothing: the Updated column stays the
  relative time.
- While a `5m` or `1h` lifetime is nearing its threshold, a 12px amber timer
  glyph follows the Updated time. Its accessible name reads **Cache ~Nm left**,
  where N is the whole-minute ceiling of the remaining time (never below 1).
- After the recorded lifetime passes, the glyph turns faint and its name reads
  **Cache lifetime elapsed**. Elapsed is a settled observation, not a call to
  act, so it never uses the amber attention color.

The glyph carries no visible text. It is the shared dotted disclosure: hover or
tap shows **Last cache touch**, **Observed lifetime**, the state, and the
reminder that an elapsed lifetime is not proof the provider dropped the entry. Rows without a primary
agent, subagent-only cache activity, and mixed, minimum-only, or missing
lifetimes render no note. Subagent caches never drive the session indication.

## Privacy boundary

The browser receives only the normalized request timestamp, normalized agent
ID, allowlisted cache lifetime, and request-local token counts already defined
by the request-snapshot contract. Raw prompts, cache-control blocks, provider
request identifiers, cache keys, model identifiers, and provider diagnostics
remain monitor-private.

The session catalog adds only `cacheTiming.lastCacheTouchAt` (a normalized
request timestamp) and `cacheTiming.cacheLifetime` (the same allowlisted
lifetime enum), or `null`. It never carries request IDs, token counts, agent
IDs beyond the fixed primary scope, or any other request-snapshot field.
