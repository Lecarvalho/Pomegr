# Session evidence privacy

> Scope: what normalized session, agent, activity, cache, file, and history evidence may reach the browser or a checkpoint.
> Authority: canonical privacy invariants for this subject. Behavior detail is in [Observation cache](../observation-cache.md) and [Metrics](../metrics.md).
> A change that widens exposure changes this page in the same pull request.

## Transcript paths

- The one-shot same-origin transcript-path endpoint may disclose a local transcript path.
- It may do so only after an explicit user copy action.
- Never include a transcript path in state, session catalogs, reports, logs, or error text.

## Agent roles and custom types

- Provider-native agent kinds and repository role-map contents are monitor-private.
- The browser receives the bounded normalized `Agent.role` enum.
- For an unmapped role only, the browser also receives `Agent.customType`.
  - It is a monitor-validated terminal identifier.
  - It is displayed as `custom: <type>`.
- Validate the entire source identifier before normalization.
- Reject paths, prose, markup, control characters, and values over 64 characters.
- Never expose the full provider kind or the mapping contents.
- Never reinterpret the custom label as a role.

Behavior: [Metrics](../metrics.md).

## Execution tasks

**May expose only:**

- normalized tool/background IDs
- the Bash description
- shell kind
- a bounded provider-neutral work kind
- lifecycle status
- timestamps
- background flag
- exit code
- a bounded enum-based failure category, derived monitor-side

**Work kind:**

- Work kind must come from a recognized structured tool identity or private command structure.
- Ambiguous work remains generic.

**Never expose:**

- commands
- stdout
- stderr
- matched source text
- task-notification output

## Activity and session history

**Activity metadata may additionally expose only:**

- a nullable bounded call-to-result wall duration (maximum 24 hours)
- an opaque normalized request ID

**The paged session-history surface:**

- It may expose normalized agent IDs.
- It may expose stable session-scoped request numbers, including links outside the
  bounded state summary.
- Its request records may carry one nullable, monitor-validated model identifier
  recorded for that request (explicitly approved by the user).
  - It has at most 120 identifier characters.
  - It is never a path, drive prefix, markup, or prose.
  - It describes that request only.
  - It never describes agent model history, routing, or service tier.
- Its committed disk history and indexes contain only allowed normalized metadata.
- GETs never acquire provider evidence.

**Other rules:**

- Work-kind aggregates contain only bounded WorkKind counts and median resolved
  durations.
- Provider call/message IDs and private request mappings remain monitor-private.
- No per-action token or cost attribution is permitted.

Behavior: [Observation cache](../observation-cache.md).

## File-change history

**Storage and serving:**

- File-change history ships as monitor-private checkpoint evidence and a monitor-owned
  SQLite index.
- The browser receives it only through two surfaces:
  - the `recorded` entries of the repository domain's `touchedFiles` block
  - the no-store `GET /api/repository-files` listing/history endpoint

**Committed records may expose only:**

- a normalized repository identity
- a bounded safe repository-relative path, bound monitor-side to its recognized root
- a fixed `created`/`edited`/`deleted`/`moved` kind
- an observation timestamp
- an opaque file identity, where continuity across paths is needed

**Attribution:**

- Normalized session and agent identities and a stable session-scoped request number
  are nullable.
- Each may appear only when recorded evidence proves that attribution.

**Agent details in the index (product-owner decision, 2026-09-30):**

- For each session agent with a recorded file change, the index may also persist
  only these three values:
  - the agent's bounded one-line display label
  - the optional recorded assignment
  - the latest reported model identifier (validated like the request model identifier)
- The monitor captures them from committed normalized agent state.
- The model is the agent's latest value.
- Never present it as the model of the request that made a change.

**Efficiency signals (product-owner decision, 2026-09-30):**

- The efficiency-signal catalog may derive shared-file and broad single-agent change
  signals monitor-side from recorded `fileChanges`.
- Those insights may expose only these values:
  - a file's basename
  - normalized agent labels and IDs
  - bounded counts
  - an opaque digest of the file identity
- Those insights never expose a repository-relative path, a repository identity, or a
  change record.

**Path validation:**

- Validate paths with a dedicated repository-path validator, not the custom-agent
  identifier validator.
- Reject these paths:
  - absolute, drive-relative, UNC, and device paths
  - paths with traversal or control characters
  - provider configuration or transcript locations
  - any path that cannot be safely contained under the recognized root
- Preserve legitimate nested relative paths.
- Never expose commands, tool arguments, provider paths, or transcript paths.

**Which tools contribute `fileChanges`:**

- Only structured file tools with an explicit target contribute `fileChanges`.
  - Claude: Write/Edit/MultiEdit/NotebookEdit.
  - Codex: patch and file-change items.
- Shell commands never contribute (Claude Bash/PowerShell, Codex shell items).
  - The files a command writes cannot be known reliably from its text.
  - Do not parse command text for file writes unless a reliable source is found
    (product-owner decision, 2026-09-24).
  - The directory of a session's own Git command is a separate read (product need of
    T-52, 2026-10-11): the Claude adapter may read the directory that a Git command names
    to find the checkout the session works in. It reads no file path from the command.
  - That directory and the checkout it resolves to are monitor-private. They are used
    only as the working directory of read-only Git and GitHub reads, after the directory
    exists and the repository resolver recognizes it as a checkout of the session's
    launch repository. They never enter evidence, a checkpoint, a response, or a log.
- A move observed only through Git may establish repository-scoped path continuity.
- Such a move must not manufacture session, agent, or request attribution.
- Such a move must not contribute to session edit counts.

**Git-observed category (product-owner decision, 2026-10-01, superseding the
2026-09-23 session-window approval):**

- The session Repository tab's Touched here list may additionally show a separately
  labeled Git-observed category.
- It holds only files changed by commits on the recorded branch.
- The commit's committer time must fall inside one of the session's own finished Git
  commands.
  - Such a command is a recorded execution task with work kind `git`, `git_push`, or
    `pull_request`.
- Files that merely changed or were committed while the session was open are never
  listed.
- It is served only as the `committed` entries of the repository domain's
  `touchedFiles` block.
- Each entry holds these values:
  - a bounded safe repository-relative path
  - the fixed `committed` source
  - a nullable fixed `added`/`modified`/`deleted` net change, read from Git's commit
    name-status (product-owner decision, 2026-09-24)
- It is never served on `/api/state` `session.repository`.
- It carries a provenance marker.
- It is never attributed to a session agent or request.
- It is never counted as a recorded edit.
- It never enters the recorded file history.
- The match is by time.
- Present it as a commit made while the session ran a Git command, not as proof of
  authorship.
- Its only time/branch join is this labeled category.
- It must never fill recorded attribution fields.

Behavior: [Observation cache](../observation-cache.md), [Metrics](../metrics.md).

## Plan tasks

**May expose only,** from the structured task store:

- normalized task ID
- subject
- status
- dependency IDs

**Never expose:** task descriptions or active-form text.

Always label the checklist as agent-maintained and potentially stale.

## Session and agent signals

**May expose only,** from a recognized Pomegr MCP tool call:

- a bounded plain-text label
- semantic tone
- transcript-derived timestamp
- an optional bounded, one-line plain-text description

**Never expose:** other MCP arguments or tool-result content.

Present signals as agent-reported, not as Pomegr judgments.

## Session events

**Feed (product-owner decision, 2026-10-01):**

- Session-event metadata is a bounded feed on the session-summary domain.
- The monitor derives it from already-committed normalized evidence.
- Its only added evidence is two bounded timestamp lists:
  - the shared Claude/Codex `userMessageTimes` evidence field
    - It holds the newest 256 recorded user-message times, checkpointed with the
      evidence.
    - It never holds content, type, IDs, or paths.
    - It never holds a time synthesized from a file time.
  - the sidecar's in-window commit times (see Historical views and repository snapshots)
- Both lists stay monitor-private.
- Both reach the browser only as event times.

**Each event may expose only:**

- an opaque ID
- a fixed kind
- the timestamp recorded with its evidence
- the fields its kind needs:
  - a normalized agent ID and label
  - a nullable wall duration
  - an agent-reported signal's label and tone
  - the progress estimate's percent and phase
  - a fixed resource field
  - a pull-request number

**Cache-refill and compaction events (product-owner decision, 2026-10-02):**

- The feed may also carry a cache-refill event.
  - There is one for each per-agent refill occurrence already served by the
    cache-event feed.
- The feed may also carry a compaction event.
  - There is one for each recorded automatic or manual compaction boundary.
- Each of these events exposes only these values:
  - the normalized agent ID and label
  - the recorded time
  - a fixed kind: `possible_full`/`provider_diagnosed`/`lifetime_elapsed`, or
    `automatic`/`manual`
- Label `lifetime_elapsed` as an inference.

**Task events (task T-57, 2026-10-11):**

- The feed may also carry an event for each of the agent's own Pomegr task tool calls
  that changes a task: `add_task`, `remove_task`, `complete_task`, `block_task`, and
  `update_task`.
- The source is the session's recorded tool calls. The feed never reads the task store,
  so it is an observation of the session, not task-board content.
- A provider adapter may mark such a tool call with one optional evidence value,
  `taskAction`: `added`, `removed`, `completed`, `blocked`, or `updated`.
  - It is set only for Pomegr's own MCP server and only when the recorded result is not
    an error.
  - It is checkpointed with the tool-call evidence and stays monitor-private. It is not
    in `/api/state`, the activity feed, a report, or a log.
- Each of these events exposes only these values:
  - the normalized agent ID and label
  - the tool call's recorded time
  - a fixed kind: `task_added`, `task_removed`, `task_completed`, `task_blocked`, or
    `task_updated`
- Label a report as the agent's report. Only the owner marks a task done.

**Session-event sidecar:**

- Events must not be withdrawn when their usage evidence slides out of the retained
  window.
- So the monitor may persist them in a separate monitor-private session-event sidecar
  next to the session checkpoint.
- The sidecar holds only a version and, for at most the newest 256 refills, 256
  compactions, and 256 task actions, these values:
  - the recorded time
  - the normalized agent ID
  - the fixed kind
  - for a task action, a count from 1 to 64 of the calls that share that time
- The monitor validates it as a whole record.
- It only accumulates from committed normalized evidence.
- It reaches the browser only as event times and kinds.

**Never expose through it:**

- user-message content or type
- request numbers
- commit hashes or subjects
- pull-request URLs
- resource values
- signal descriptions
- refill reasons
- statuses
- inference details
- token counts
- cache percentages
- task IDs, task text, feature names, block reasons, or attention lines
- tool arguments, tool results, or tool-call IDs
- prior context totals
- provider IDs

**Other rules:**

- Commit and pull-request events carry no agent or request attribution.
- Historical sessions never gain events from current Git state.
- Never derive an event from a sliding window or from live-only state.
  - An event must not be shown and later withdrawn while its evidence is retained.
- Signals and estimates are latest-only.
- `total` counts the events derivable from retained evidence.
- Never present `total` or the feed as a complete session history.

Behavior: [Metrics](../metrics.md).

## Task signals

- Task-signal metadata may attach the same bounded fields only to a matching normalized
  execution task.
- The monitor resolves the match monitor-side from a safe tool-use or background-task
  ID.
- Never expose the MCP-supplied target separately.
- Never include unmatched task signals in the browser API.

## Context history

**May expose only:**

- bounded bucket timestamps
- actual context totals
- normalized visible-agent IDs with their actual context totals
- bounded normalized boundaries, each containing:
  - an opaque ID
  - a normalized agent ID
  - a timestamp
  - a fixed automatic-compaction/manual-compaction/snapshot-drop kind
  - an optional prior context total

**Never expose through this surface:**

- raw usage records
- provider message IDs
- compaction summaries or content
- unrecognized provider metadata
- cache-category history

## Agent cache lifetime

- Agent cache-lifetime metadata may expose only the aggregate `5m`, `1h`, `mixed`,
  `30m+`, or `null`.
- It derives the aggregate from every retained, resolved request lifetime for that
  normalized agent.
- `30m+` is a documented model-policy minimum, rendered `≥30m`.
- `30m+` is never a recorded expiry or an expiry-inference threshold.
- The aggregate is per agent, never session-wide or latest-only.
- Raw provider cache-control blocks and token breakdowns remain monitor-private.

## Cache events

**May expose only:**

- a bounded normalized event ID
- a normalized agent ID
- a recognized event kind
- an observation timestamp
- a prompt-input token count
- cache-read percentages
- a cache-write token count
- an elapsed gap
- a normalized related-event ID
- bounded per-agent possible-full-refill counts
- an optional bounded occurrence kind (see below)
- bounded counts of recognized provider-diagnosed request-divergence categories
- the provider-neutral `previous_cache_entry_unavailable` status
- a bounded lifetime-expiry inference containing only `5m`/`1h`/`mixed` plus elapsed
  milliseconds
- bounded fixed tool-definition labels/change kinds from a recognized monitor-side
  lifecycle attribution
- for the recognized deferred-definition rule only, a bounded positive count (at most
  64) of newly recorded tool definitions
  - Never expose their names, descriptions, or schemas.

**Occurrence kind:**

- The optional bounded occurrence kind has only two values.
  - `provider_diagnosed`: a recognized provider reason on a partial rewrite that keeps
    part of the prefix.
  - `lifetime_elapsed` (product-owner decision, 2026-10-02): a partial rewrite with no
    recognized reason that carries the lifetime-expiry inference and lost most of its
    cached tokens.
- Each kind has its own bounded per-agent count.
- That count never joins the possible-full-refill count, session-report totals, or
  miss-refill events.

**Inferences:**

- Inferences must be explicitly labeled as inferences.
- Inferences require complete structural evidence.

**Never expose:**

- raw lifecycle records
- diagnostics
- diagnostic token estimates
- usage records
- provider message/session/bridge IDs
- model identifiers
- comparison groups
- cache keys
- prompts
- schemas
- raw cache-lifetime token breakdowns
- inferred cost and savings

## Request snapshots

**May expose only:**

- a bounded opaque ID
- a normalized agent ID
- an observation timestamp
- the resolved `5m`/`1h`/`mixed` cache lifetime, the documented `30m+` minimum, or
  `null`
- normalized request-local uncached-input, cache-write, cache-read, and output counts
- their recomputed request-local total
- bounded per-request work-kind tallies with a fixed association label

**Never expose:**

- raw usage records
- provider cache-control blocks or lifetime token breakdowns
- provider message/session/event IDs
- model identifiers
- comparison groups
- dedupe keys
- provider totals
- cumulative totals
- prompts
- billing fields

**Exception:**

- The paged session-history request model above is the sole exception.
- It never enters the `/api/state` request-snapshot feed, cache evidence, or reports.

**Session catalog:**

- The session catalog may additionally expose, per row, two values:
  - the primary agent's newest cache-touch observation timestamp
  - the allowlisted cache lifetime (or `null`)
- The Sessions page uses them to show a nearing/elapsed note.
- The catalog never carries request IDs, token counts, or subagent cache evidence.
- Never present an elapsed lifetime as proof that the provider dropped the entry.

Behavior: [Cache timing](../cache-timing.md).

## Cache-read drops

- Cache-read-drop metadata is separate from write-backed refill evidence.
- It may expose only these values:
  - readiness
  - normalized agent IDs
  - bounded counts
  - opaque occurrence IDs
  - original observation timestamps
  - preceding/current cache-read percentages
  - elapsed gaps
  - the optional bounded kind `model_change`
- Numeric eligibility and predecessor timestamps stay monitor-private.
- An omitted kind is the same-model possible-refill inference.
- `model_change` is labeled **Cache reuse dropped across a model change**.
- `model_change` carries no refill, expiry, or causation inference.
- Exclude both read-drop kinds from write-backed event/report totals.
- Never expose model identifiers.

## Historical views and repository snapshots

**Historical views:**

- Never expose current plan limits.
- Never substitute the current Git working tree for recorded session state.

**A historical repository snapshot** is a bounded sidecar next to the session
checkpoint. It holds only these values:

- the recorded branch
- the main-branch flag
- bounded recorded uncommitted files (status and safe repository-relative path)
- branch comparison
- allowlisted pull-request state with their original check times
- `commitsInSession`
- the bounded session-commit list (version 6)
  - It holds paths changed by commits made while one of the session's own Git commands
    ran.
  - It holds their aligned fixed net changes, or null.
  - It holds a truncation flag.
  - The window-wide lists of versions 2 to 5 are validated on load and dropped.
- a nullable validated repository identity (version 4)
- the bounded in-window commit times (version 5; product-owner decision, 2026-10-01,
  as part of the session-events feed)
  - They are at most the newest 50 committer timestamps.
  - They are never hashes, subjects, or authors.
  - They are served only as session-event times.
  - They are never served on `/api/state` `session.repository` or the repository
    domain.

**Snapshot rules:**

- The monitor validates the snapshot as a whole record.
- The monitor never refreshes it from current Git or GitHub state.

**Serving:**

- The repository domain may add only these values to it:
  - `recordedAt`
  - `commitsInSession`
  - a `gitTasks` total/failed count
- `/api/state` `session.repository` may carry `recordedAt` and `commitsInSession` too.

## Observation checkpoints

- Observation checkpoints may persist only these values:
  - contract-valid normalized evidence
  - bounded source fingerprints and complete-record offsets
  - readiness
  - revision
  - observation timestamps
- Never persist raw provider records, incomplete fragments, transcript paths, or other
  browser-forbidden content.
