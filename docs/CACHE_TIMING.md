# Cache timing

Pomegr keeps agent execution state separate from cache timing. Agent labels such
as **active**, **warm**, **idle**, and **finished** describe observed execution or
liveness evidence; they do not describe prompt-cache availability.

## Times shown for an agent

- **Last model turn** is the newest retained valid request snapshot for that
  normalized agent.
- **Last cache touch** is the newest retained valid request snapshot for the
  same agent with a positive cache-read or cache-write token count.

These times often match, but they do not have to. A model request can have no
reported cache activity, and a provider can omit cache details that Pomegr would
need for a cache-timing estimate.

Both values come from the bounded request-snapshot feed. They are not derived
from `Agent.lastSeen`, provider lifecycle updates, filesystem observation time,
or cumulative token totals.

## Lifetime indication

Pomegr evaluates a cache lifetime only when the latest cache-touch request
itself carries a resolved `5m` or `1h` lifetime:

- A five-minute lifetime enters the **nearing threshold** state during its last
  minute.
- A one-hour lifetime enters the **nearing threshold** state during its last
  five minutes.
- After the recorded lifetime passes, Pomegr reports **lifetime threshold
  elapsed**.

Outside the nearing and elapsed states, **Last model turn** remains ordinary
text without an underline or popover. Pomegr adds the disclosure affordance only
when it has cache timing that needs attention.

Mixed, missing, malformed, or otherwise unavailable lifetime evidence does not
produce a warning. Historical sessions show recorded request and cache-touch
times without a live warning state.

An elapsed lifetime is not proof that a cache entry expired. Provider retention
can exceed a documented minimum, and cache availability can also change because
of prefix changes, routing, eviction, model changes, or a prefix that was never
written. Pomegr therefore keeps the indication amber and uses cautious wording.

## Privacy boundary

The browser receives only the normalized request timestamp, normalized agent
ID, allowlisted cache lifetime, and request-local token counts already defined
by the request-snapshot contract. Raw prompts, cache-control blocks, provider
request identifiers, cache keys, model identifiers, and provider diagnostics
remain monitor-private.
