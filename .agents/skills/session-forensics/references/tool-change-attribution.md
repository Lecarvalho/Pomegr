# Tool-change attribution

Read this reference only when a provider records `tools_changed` or the user asks which tool definitions changed.

## Core distinction

`tools_changed` proves that the provider classified the request prefix as having different tool definitions. It does not identify the changed tools unless the transcript also stores a literal bounded roster delta.

An attribution rule may identify likely tools from structural lifecycle evidence. Report that result as a **Pomegr inference** or **strong inference**, not as provider-recorded fact.

## General attribution requirements

A tool-change rule is usable only when all of these are true:

1. The affected request has the provider diagnostic `tools_changed`.
2. The transcript interval needed by the rule is complete: the reader covered byte zero through the observed file size without a partial first line, or a trusted provider adapter explicitly marked the history complete. Parse failures or rotation/truncation that intersect the rule window make it incomplete.
3. The candidate transition is a provider-owned structural record, not text authored by the user or agent.
4. A stable pre-transition baseline is present.
5. The expected post-transition state recurs or otherwise persists.
6. The transition is tied to the affected request boundary, not merely close in wall time. Missing or malformed request identities make cross-request attribution unavailable.
7. The rule maps to a fixed bounded tool delta and exposes no raw schemas.
8. No competing qualifying transition exists between the preceding distinct request and the affected request. Scan recognized connection, plugin/MCP, configuration, model, system, and tool-lifecycle records; two qualifying rules make the result ambiguous.

If any requirement fails, leave the exact tools unavailable.

## Remote Control connection rule

Use this rule for Claude Code Remote Control only.

### Required evidence

All conditions must hold:

1. The inspected history covers the session baseline through the affected request.
2. At least one distinct assistant request appears before any structurally valid `bridge-session` record for the selected session. This establishes a bridge-free baseline.
3. The first valid `bridge-session` record is bound to the selected transcript session and carries a distinct bridge-session identity plus a non-negative sequence number.
4. Within a small bounded number of records, a provider-owned `system` record with subtype `bridge_status` begins with the canonical active Remote Control status.
5. Record the assistant request active at connection time. Later streamed fragments with the same request identity do not count as the next request.
6. A provider-owned `last-prompt` boundary for the selected session occurs after activation.
7. After that boundary, another `bridge-session` record uses the exact same transcript session and bridge identity. A lower sequence invalidates the candidate. An unchanged sequence is allowed because a completed turn can emit bridge state without transferring a remote message.
8. The first distinct request after activation carries `cache_miss_reason.type = tools_changed`.

### Fixed likely tool delta

When every condition holds, report:

- `RemoteTrigger` — likely added;
- `PushNotification` — likely added;
- `ListAgents` — likely definition changed because its behavior or description becomes conditional on Remote Control connectivity.

Suggested wording:

> Provider diagnostic: tool definitions changed. Strong inference: Remote Control connected; the likely definition delta is RemoteTrigger added, PushNotification added, and ListAgents changed.

Also state that the transcript records the reason and lifecycle transition, not a literal before/after schema diff.

### Evidence that does not qualify

Do not attribute Remote Control from any of these alone:

- `/remote-control` mentioned in a skill listing or prompt;
- a `deferred_tools_delta` at the first user turn;
- the names `RemoteTrigger`, `PushNotification`, or `ListAgents` appearing in text;
- a bridge already present at session start;
- only one bridge-session occurrence;
- recurrence from a different transcript session or bridge identity;
- a repeated bridge record without the completed-turn boundary;
- incomplete history that cannot prove the bridge-free baseline;
- `tools_changed` on a later request after an intervening distinct request;
- multiple simultaneous integration transitions.

## Extending the rule set

Add a new attribution only after observing a repeatable provider-owned lifecycle signature. Define:

- the trusted transition record shape;
- how a pre-transition baseline is proved;
- the required post-transition persistence signal;
- the exact request-boundary correlation;
- the fixed allowlisted tool delta;
- false-positive cases and ambiguity behavior.

Do not create a universal rule from one textual coincidence or a timing correlation.
