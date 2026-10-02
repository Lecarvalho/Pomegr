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

## Reconstruct deferred-tool changes

Pomegr ships a bounded rule for this case, described in the deferred-definition
paragraph of [Cache events](../../../../docs/internal/architecture/metrics.md#cache-events).
It reports only the fixed cause and a count of newly recorded definitions, never
names. Use the procedure below by hand when that rule declines (for example an
ambiguous interval, a competing transition, incomplete history, or a client
version it was not verified against) or when you need the batch's names for your
own analysis. This is a forensic method, not permission to expose arbitrary tool
names in browser state. The existing runtime allowlist remains unchanged.

### Establish the recorder semantics

Verified on 2026-10-01 against the locally installed Claude Code 2.1.286 native
client: its embedded JavaScript reconstructs a map of previously recorded
deferred definitions by tool name. The record writer compares each candidate
entry with the previous entry using an equality helper and emits entries whose
definitions differ. An absent prior entry qualifies as new. It separately
records changes to `nameOnlyAnnouncements`, `strippedReferences`, and
`toolInputCopies`; these are not definition entries.

For another version, read the selected transcript's `version` field and inspect
the matching installed client artifact, when available. Native binaries can
contain readable embedded JavaScript. Search locally for
`deferred_tools_record`, then follow the reader, writer, equality helper, and
writer call sites. Verify the producer's relationship to the outbound request;
the presence of a string in a binary alone proves no behavior. Minified function
names are unstable. Do not run a new provider session or alter installation
state merely to inspect code. If version-matched code is unavailable, label the
recorder interpretation provisional rather than assuming newer versions match.

### Reconstruct the boundary

1. Read the selected transcript from byte zero through a captured file size.
   Record parse failures and incomplete lines. Deduplicate assistant fragments
   by valid provider request identity and match the anchor to normalized history
   request numbering; a primary-agent ordinal can differ from the session-wide
   request number.
2. Replay `deferred_tools_record.entries` in transcript order into a private map
   keyed by exact tool name. Compare definitions structurally, ignoring object
   key order while preserving array order and values. Keep descriptions and
   schemas private. Classify an emitted entry as newly recorded when no prior
   entry exists, changed when a prior definition differs, or unchanged when it
   matches. For changed entries, report only bounded field-category differences,
   such as description or input schema, never their contents.
3. Separate `deferred_tools_delta` name advertisements from full definitions.
   A name in `addedNames` does not prove that its full schema was already loaded.
   An empty `entries` array can record input-copy bookkeeping; it is not a
   definition change. Missing entries do not establish removal.
4. Between the preceding distinct request and the affected request, identify
   the structured discovery call, its matching result, and the ensuing
   definition record. Inspect privately; output only relationship checks and
   validated names from the literal definition delta. Require `tools_changed`
   on the first distinct request after that record and scan for competing
   integration, configuration, model, or system transitions.
5. Check subsequent requests for repeated definition changes and restored cache
   reuse. Recurrence strengthens the boundary interpretation; restored reuse
   supports recovery but does not identify which individual definition caused
   invalidation. If several definitions were added together, report the batch.

### Calibrate the conclusion

Recorded evidence comprises the definition entries and provider diagnostic.
Attributing the refill to that loading boundary is a strong inference only with
complete history, a coherent baseline, a matched request boundary, and no
competing transition. Say "newly recorded deferred definitions" unless client
code or a complete request snapshot proves their earlier wire absence. A
definition record is not a complete before/after outbound tool-roster snapshot.
Do not claim a single culprit within a batch or claim that a schema was edited
when no prior definition is available.

The verified example had eight newly recorded Claude-in-Chrome definitions:
`computer`, `find`, `javascript_tool`, `navigate`, `resize_window`,
`tabs_close_mcp`, `tabs_context_mcp`, and `tabs_create_mcp`. Their names had been
advertised earlier; their definitions were recorded immediately after discovery
and before the request diagnosed as `tools_changed`. This supports the batch
attribution "Chrome tool definitions loaded", not an edit to one existing tool.
This example establishes the investigation method, not a universal Chrome rule.

## Extending the rule set

Add a new attribution only after observing a repeatable provider-owned lifecycle signature. Define:

- the trusted transition record shape;
- how a pre-transition baseline is proved;
- the required post-transition persistence signal;
- the exact request-boundary correlation;
- the fixed allowlisted tool delta;
- false-positive cases and ambiguity behavior.

Do not create a universal rule from one textual coincidence or a timing correlation.
