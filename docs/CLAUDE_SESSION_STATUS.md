# Claude Code session status

## Source and evidence

Claude Code has two distinct status surfaces. The interactive REPL updates its local
session registry with lifecycle status. Remote Control launches an SDK CLI worker:
its local registry contains process ownership and a bridge-session association, but
Claude Code 2.1.251 does not write the worker lifecycle there. The absence of that
field is not an idle signal. Worker status describes the primary execution loop;
it does not establish that the session has no running background work.

The Agent SDK declares a `system/session_state_changed` message with explicit
`running`, `requires_action`, and `idle` states. Its idle notification occurs after
held-back output is flushed and the background-agent loop exits. Remote Control
forwards this state to the provider service as `worker_status`. It is not necessarily
persisted in the local transcript. Stop hooks, file modification time, process
presence, peer capabilities, and active-agent counts cannot substitute for it.

This integration was checked on 2026-08-31 against the installed Claude Code
2.1.251 client, the Agent SDK 0.3.241 declarations, and read-only live responses for
two locally registered Remote Control sessions. Both responses matched their local
bridge identities. The CLI's own session metadata reader uses the endpoint below.
This is an observed native-client API, not a promised stable public API; unfamiliar
schemas are unavailable, never guessed.

Official background: [Agent view](https://code.claude.com/docs/en/agent-view) describes
the local registry and roster, and [hooks](https://code.claude.com/docs/en/hooks)
describes hook boundaries. Neither makes a missing SDK registry status authoritative.

## Read-only request boundary

Pomegr may send the existing local Claude OAuth access token only to:

`GET https://api.anthropic.com/v1/code/sessions/{bridgeSessionId}`

This is an explicitly authorized exception to the usage-only OAuth rule in
`AGENTS.md`. It is limited to locally discovered live sessions whose registry
`entrypoint` is `sdk-cli`, with validated PID/process-start ownership and a bounded
`session_` or `cse_` bridge ID. These two native prefixes are aliases; the entire
remaining identifier must match the returned session ID exactly. Pomegr never lists
remote sessions or searches by title, project, or account metadata.

Requests use Bearer authentication and Anthropic's version header. The origin is
fixed, redirects are rejected, and each request has a six-second timeout and a
256 KiB response limit. There are at most four concurrent requests and fifty cached
associations. A successful read is reused for ten seconds; failures retry after
sixty seconds. Reads are coalesced across catalog and session hydration. Authentication
comes from the existing provider-owned credential file; Pomegr never logs in,
refreshes tokens, enrolls a device, connects to a worker, reads events, or sends
control messages. Missing account access is handled independently of transcript
observation and other providers.

## Deterministic normalization

Accept the native `response_shape` envelope, or the older `session` envelope, only
when the bounded returned identity matches. Ignore every field except identity,
archival state, and the allowlisted worker status. An archived session does not
supply an execution observation.

| Native worker status | Sessions page | Primary agent |
| --- | --- | --- |
| `running` | Working | `active` |
| `requires_action` | Needs input | `needs_input` |
| `idle` | Working if recorded background work remains open; otherwise Open while the local runtime owner is validated | `idle` |
| Missing, unrecognized, mismatched, or unavailable | No new observation | No new observation |

For a live session without a prior valid observation, the status is unknown. A temporary failure
retains the last valid observation for that same local session, owner, bridge, and
credential identity without advancing its timestamp. This is last-observed state,
not proof of the current state during a network outage. Removal or reassignment of
the local owner/bridge, or credential replacement/removal, prevents cache reuse.
A successful unchanged poll also preserves the original transition-observation time.
Historical hydration makes no remote status request for the historical session.

A validated registered runtime keeps the session in **Live** between turns, with
**Open** as its session label after primary and background work become idle. The
primary agent still shows **idle**. Registration without validated process ownership
does not establish Open; neither do transcript recency or a fresh browser poll.

A non-live Claude catalog row uses **Idle** as a fallback meaning no live session
is detected. With the registry available, this applies after the session has no
validated registration and its primary/subagent activity is outside the existing
fifteen-second registration grace period. Without a registry, the existing
five-minute activity window still determines liveness. This is a Pomegr
classification, not provider-confirmed idle, completion, or successful work.
Live sessions with unavailable lifecycle evidence remain **Unknown**.

### Background execution is independent of primary idle

The SDK also emits `system/background_tasks_changed`, a full replacement snapshot
of live background tasks. Claude publishes a related `running_background_tasks`
list in worker-private internal metadata. The ordinary session metadata response
does not include it. A read-only probe of the current worker metadata route returned
403 for ordinary OAuth; Pomegr does not use that route, mint worker credentials,
attach, or read the remote event stream.

For locally recorded background work, Pomegr instead reduces provider-authored
successful `Workflow` (`async_launched`, `local_workflow`), `Bash`
(`backgroundTaskId`), and native `Agent` (`status: async_launched`, `isAsync: true`,
bounded `agentId`) results, matched to their preceding structured tool calls.
The exact task remains open until a provider queue notification or trusted
system-delivered task notification reports a recognized terminal status for that
task ID. A bounded workflow manifest with the exact run ID, `status: completed`,
and a valid provider completion timestamp at or after that task's launch also closes
that attempt, even before its delayed notification arrives. Claude can resume a
workflow with the same run ID and a new task ID while leaving its previous completed
manifest in place. Matching the run ID alone therefore does not establish completion
of the latest attempt. Missing, invalid, or older completion timestamps do not close
recorded work. Completion memory is scoped to the launch, and workflow detail uses
the same ordering check against its latest recorded launch, including on cache hits.
Partial or mismatched manifests do not close work. A launch request alone, user-authored notification text, file age, agent
counts, and workflow progress percentages are not execution evidence.

This local lifecycle is scoped to the validated owner PID/process-start identity
and registry `startedAt`; launches before that process started are excluded. A
process replacement or missing ownership cannot inherit open work from the previous
process. Scope is recorded workflow, background-shell, and native background-agent
launches in the primary transcript; unrecorded SDK background tasks remain outside
this local observation surface. A confirmed background-agent launch covers its
execution while it works on nested children. The exact agent ID must receive a
trusted terminal notification; another child's completion cannot close its parent.
A missing child file, foreground result, text-only agent reference, or requested
`run_in_background` flag is not a substitute for the structured launch result.
Child file age and missing stop reasons do not end recorded background work.

U1 reads the complete primary transcript in cooperative 64 KiB chunks, then only
appended records. It retains at most fifty sessions, 256 pending tool identities,
and 256 open task identities per session, all monitor-private. The 256 KiB fragment
bound controls acquisition only. Malformed, oversized, or incomplete replacement
input cannot erase the last valid lifecycle observation. No transcript tail window
or silence timer expires already observed open work. Background running makes the
Sessions row Working even when the primary agent remains Idle; Needs input has
priority. Terminal work returns the row to the primary state on the next catalog
commit. Historical rows never inherit current background activity.

U1 catalog discovery and source acquisition perform network refreshes. The U2
evidence reducer only applies the cached normalized snapshot and never calls the
remote API. The primary agent consumes the native worker lifecycle; the catalog additionally
accounts for the independent recorded background lifecycle, including confirmed
native background-agent launches. A native state can clear an older unresolved
transcript question. Existing per-agent recency status and parent waiting derivation
remain separate; agent counts and these presentation heuristics never determine
catalog status.
A lifecycle transition changes the private source fingerprint so it can commit
without requiring a new transcript record. Incomplete transcript replacements still
retain the prior complete evidence revision.

## Latency

One local measurement on 2026-08-31 observed two concurrent API responses reach
headers in 160 ms and 267 ms. A complete cold catalog refresh, including local
discovery and normalization, took 781 ms; the cached refresh took 53 ms with no
additional requests. This is a single environment sample, not a latency guarantee.

Network latency affects publication of a fresh background catalog, never the
response time of a cache-only browser GET. Freshness also includes the ten-second
reconciliation interval and ten-second cache window; a poll just before expiry
can defer the next request to the following tick (roughly twenty seconds, plus
request and scheduling time). With more than four uncached sessions, requests
run in waves: the fifty-association bound can require thirteen waves. During
timeouts or the sixty-second failure cooldown, the last committed catalog remains
servable.

## Privacy and verification

Only normalized status, needs-input state, and a local observation timestamp may be
retained as evidence. Raw remote metadata, titles, configuration, summaries,
participants, action details, payloads, HTTP errors, credentials, remote IDs, and
request URLs never enter browser APIs, logs, reports, diagnostics, or checkpoints.
The private association cache is memory-only. The response is discarded immediately
after bounded normalization. No new browser fields or endpoints are introduced.

The operational phase, cache, revision, and persistence rules are canonical in
[Observation cache](OBSERVATION_CACHE.md). Regression coverage lives in
`tests/claude-session-status.test.mjs` and `tests/claude-background-lifecycle.test.mjs`; existing provider-observation and serving
tests enforce atomic replacement and cache-only GETs. Run the focused file while
iterating, then `npm run verify:fast` and `npm test` before handoff.
