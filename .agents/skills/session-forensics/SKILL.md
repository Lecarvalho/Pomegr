---
name: session-forensics
description: Diagnose coding-agent session anomalies and delayed Pomegr live updates using local session evidence and Perfetto pipeline traces. Use for cache/context/compaction/tool-change investigations, late Activity or Request updates, and capture-based performance comparisons; not general application debugging.
---

# Session Forensics

Reconstruct what happened from local evidence, separating provider-recorded facts, measured Pomegr behavior, and inference.

## Choose the evidence

- For cache refills, context changes, compactions, or tool-definition changes, follow the provider investigation below.
- For delayed Activity/Request rows, slow convergence, stalled live updates, or a supplied Perfetto trace, read [references/perfetto-diagnostics.md](references/perfetto-diagnostics.md). A session ID is not required to analyze the identity-free pipeline trace. Use native SQL for diagnosis; open the viewer when a visual explanation helps or the user asks.
- For a mixed question, investigate each evidence source separately. A Pomegr delay does not explain a provider cache decision. Coincident timestamps do not establish that an anonymous trace flow belongs to a named request or session.

## Scope and authorization

- An explicit request to diagnose a named local session authorizes read-only inspection of that session's transcript and related provider-owned metadata.
- Keep the investigation read-only. Do not alter transcripts, provider state, configuration, caches, sessions, or running processes unless the user separately requests that action.
- Stay within the named session and directly related child records. Do not inspect unrelated sessions merely because they are nearby.
- A request to diagnose Pomegr performance authorizes reading sanitized local diagnostics and saving the development recorder's recent buffer through its authenticated local listener. Preserve recent history before investigating further. It does not authorize raw transcript inspection, restarting the app, or changing diagnostic configuration. Production and desktop builds have no recorder. Use existing authorization for separately requested setup/restarts; otherwise report the missing prerequisite.

## Provider evidence hierarchy

Prefer evidence in this order:

1. A provider-recorded diagnostic attached to the affected request.
2. Provider-owned structural lifecycle records.
3. Transcript order and timestamps, including a complete expected-record absence followed by consistent recurrence.
4. A documented, bounded mapping from a lifecycle transition to likely context changes.
5. Timing-only explanations such as cache TTL, eviction, or routing.

Call levels 1–2 **recorded evidence**. Call levels 3–4 **inference**. Treat level 5 as a possible explanation, never a finding, unless the provider recorded it directly.

## Provider investigation workflow

1. Resolve the exact provider and session from the supplied identifier. Prefer an existing provider adapter or Pomegr's normalized state. If raw discovery is needed, search by exact session ID and never disclose the transcript path.
2. Anchor the event: identify its request, normalized agent, timestamp, usage transition, and any provider diagnostic. Deduplicate streamed fragments that share one provider request identity. If a rule needs cross-request ordering and the provider identity is missing or malformed, leave that attribution unavailable instead of inventing a fallback identity.
3. Build a sanitized chronology around the anchor. Retain only record index, timestamp, recognized type/subtype, request-boundary relationships, and boolean structural matches. Do not print raw records into tool output.
4. Check direct provider evidence before considering TTL. Recognized cache divergence categories may include `model_changed`, `system_changed`, `tools_changed`, and `messages_changed`. Treat `previous_message_not_found`, `unavailable`, missing, malformed, and unknown values as inconclusive.
5. When the diagnostic is `tools_changed`, read [references/tool-change-attribution.md](references/tool-change-attribution.md) and apply only rules whose complete evidence requirements are satisfied.
6. Look for competing structural changes from the end of the preceding distinct request through the start of the affected request. Include recognized connection, plugin/MCP, configuration, model, system, and tool-lifecycle transitions. If multiple candidates satisfy their own rule, report the attribution as ambiguous rather than choosing one.
7. State what the transcript proves, what is inferred, what remains unavailable, and why weaker explanations do or do not fit.

## Absence and timing rules

- Absence is evidence only when the inspected history is complete for the relevant interval and the record is known to be emitted in that state. For raw files, prove completeness by reading from byte zero through the observed file size, rejecting a partial first line, recording parse failures, and confirming that the required baseline precedes the candidate transition. A provider adapter's explicit complete-history flag may substitute for these checks. Otherwise label history incomplete. Strengthen absence with observed recurrence after the transition.
- A textual mention, skill listing, prompt fragment, or tool result is not a lifecycle transition.
- Transcript order can be more precise than timestamps when provider-owned records omit timestamps. Say when order, rather than time, supports the conclusion.
- Convert time zones explicitly and retain the original timestamp. Do not compare local and UTC values without labeling them.
- Do not treat a nominal one-hour cache TTL as an exact guarantee. A refill before one hour can be caused by changed input, eviction, routing, or another provider condition. A gap near or beyond one hour does not prove expiration.

## Privacy boundary

- Never reproduce prompts, responses, reasoning, commands, tool results, credentials, raw diagnostic objects, cache keys, provider owner/account identifiers, bridge identifiers, or tool schemas.
- Do not reveal local transcript or credential paths.
- Tool names may be reported only when they come from a literal bounded roster delta or a fixed documented attribution rule.
- Use the user-supplied session ID only as needed to identify the subject. Keep other provider message and request IDs private.
- Prefer fixed summaries over exception text or raw parser output.

## Reporting

Lead with the conclusion and use calibrated language:

- **Recorded:** directly stored by the provider.
- **Measured:** directly observed by Pomegr instrumentation, with its measurement boundary, capture coverage, and clock uncertainty stated. This is separate from provider evidence.
- **Strong inference:** one complete structural rule fits and no competing transition does.
- **Possible:** timing or incomplete evidence fits but does not identify a cause.
- **Unavailable:** the required evidence is absent, truncated, malformed, or ambiguous.

For a cache refill, report:

1. the recorded cache diagnostic, if any;
2. the likely changed context component or tools;
3. the structural evidence chain in chronological order;
4. why TTL or another alternative is weaker or still possible;
5. confidence and the precise limitation, such as “the transcript has no literal before/after tool-schema diff.”

Keep the final answer concise unless the user asks for a full evidence table.
