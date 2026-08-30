# Signal dictionary

This dictionary defines the stable, public codes Pomegr may show for deterministic evidence and bounded inferences. The dashboard stays compact; this document carries the evidence rule and its limits. Signals describe what Pomegr observed. They are not billing statements, provider guarantees, or proof of an internal implementation cause.

## Cache signals

### `cache.possible_full_refill`

Pomegr observed two comparable requests for the same normalized agent and model, with no compaction between them. The preceding request had at least 8,000 prompt-input tokens and an 80% cache-read share. The current request had at least 8,000 prompt-input tokens, no more than a 10% cache-read share, and at least 8,000 cache-write tokens.

This is deterministic threshold evidence of a possible near-full rewrite. It does not prove a charge, cost, provider defect, or why the request changed.

<a id="cache-model-changed"></a>

### `cache.model_changed`

The provider recorded the recognized request diagnostic `model_changed` on a request that met Pomegr's possible full-refill thresholds.

This means the provider reported that the model configuration differed from the preceding comparable request. It does not identify the changed model field, establish why it changed, or prove that the model change alone produced the refill evidence.

Pomegr exposes no model identifier, comparison group, raw diagnostic, request ID, cache key, prompt, or diagnostic token estimate through this signal.

<a id="cache-system-changed"></a>

### `cache.system_changed`

The provider recorded the recognized request diagnostic `system_changed` on a request that met Pomegr's possible full-refill thresholds.

This means the provider reported that the system instructions differed from the preceding comparable request. It does not identify the changed instruction, expose its content, establish why it changed, or prove that the system change alone produced the refill evidence.

Pomegr exposes no system prompt, raw diagnostic, request ID, cache key, or diagnostic token estimate through this signal.

<a id="cache-messages-changed"></a>

### `cache.messages_changed`

The provider recorded the recognized request diagnostic `messages_changed` on a request that met Pomegr's possible full-refill thresholds.

Pomegr does not expose raw diagnostics, provider IDs, prompts, message content, or diagnostic token estimates. The diagnostic says the request's message history diverged; it does not identify the exact changed message or establish why it changed.

<a id="cache-tools-changed"></a>

### `cache.tools_changed`

The provider recorded the recognized request diagnostic `tools_changed` on a request that met Pomegr's possible full-refill thresholds.

This means Claude reported that the request's tool definitions differed from its preceding comparable request. By itself, this does not identify which definition changed, why it changed, or whether an external lifecycle event caused the change.

Pomegr exposes no raw tool schemas, provider diagnostics, request IDs, cache keys, or provider lifecycle records through this signal.

<a id="cache-previous-cache-entry-unavailable"></a>

### `cache.previous_cache_entry_unavailable`

Class: bounded provider status attached to refill evidence.

Pomegr emits this code when a recognized provider diagnostic maps to the normalized status `previous_cache_entry_unavailable`, no more specific recognized divergence reason is available for that occurrence, and the request meets Pomegr's possible full-refill thresholds.

What it means: the provider indicated that the preceding cache entry was unavailable for the affected request.

What it does not prove: why the entry was unavailable, that its configured lifetime expired, that the entire prompt prefix was rewritten, or that the provider charged any amount. When the preceding request's resolved cache lifetime and elapsed wall time independently support expiry, Pomegr shows that conclusion separately as an inference.

Privacy: browser state contains only the fixed provider-neutral status and stable public code. Raw provider diagnostics, cache keys, request and message IDs, model identifiers, prompts, token estimates, and billing fields remain monitor-private.

<a id="cache-lifetime-elapsed"></a>

### `cache.lifetime_elapsed`

Class: bounded cache-expiry inference attached to refill evidence.

Pomegr emits this code only when there is no recognized direct divergence reason, the preceding request has a resolved `5m`, `1h`, or `mixed` cache lifetime, the full applicable threshold has elapsed, and either the provider reports `previous_cache_entry_unavailable` or the affected request contains no cache-miss diagnostic. The full threshold is five minutes for `5m` and one hour for `1h` or `mixed`.

What it means: the preceding request's resolved cache-lifetime threshold elapsed before the affected comparable request, and that request met Pomegr's possible full-refill thresholds.

What it does not prove: that expiry was the provider's actual cause, when the provider removed an entry, that every cached segment expired, or that the provider charged any amount. Pomegr always labels this conclusion as an inference.

Privacy: browser state contains only the resolved lifetime enum, elapsed milliseconds, fixed inference cause, and stable public code. Raw cache-control blocks, lifetime token breakdowns, cache keys, requests, prompts, model identifiers, and billing fields remain monitor-private.

<a id="cache-tools-changed-remote-control-connected"></a>

### `cache.tools_changed.remote_control_connected`

Class: bounded lifecycle attribution attached to provider diagnostic and refill evidence.

Pomegr emits this code only when complete Claude Code transcript history contains the recognized Remote Control bridge activation lifecycle, the lifecycle remains coherent for the same session, and the affected request carries Claude's `tools_changed` diagnostic and meets Pomegr's possible full-refill thresholds.

What it means: Claude reported changed tool definitions at the same occurrence where Pomegr observed the fixed Remote Control connection transition. The browser may show only the fixed normalized changes: `RemoteTrigger` added, `PushNotification` added, and `ListAgents` definition changed.

What it does not prove: Remote Control caused the refill, no other tool changed, the provider charged any amount, or the normalized fixed change list is a raw provider schema diff.

Privacy: browser state contains only the fixed attribution enum, fixed tool labels and change kinds, and stable public code. Provider session and bridge IDs, raw lifecycle records, tool schemas, prompts, results, and diagnostics remain monitor-private.

<a id="cache-messages-changed-post-tool-notification-resume"></a>

### `cache.messages_changed.post_tool_notification_resume`

Class: observed sequence attached to provider diagnostic and refill evidence.

Pomegr emits this code only when complete Claude Code transcript history establishes all of the following:

1. An assistant message contains a structured `tool_use`.
2. A later structured user `tool_result` matches that tool-use ID.
3. The next relevant user record is provider-owned metadata with `origin.kind` equal to `task-notification`.
4. The next distinct assistant request is directly parented to that notification when both UUIDs are available.
5. That request carries Claude's recognized `messages_changed` diagnostic and meets Pomegr's possible full-refill thresholds.

Unrelated user input, incomplete history, malformed records, an unmatched tool result, a user-authored lookalike, or an intervening assistant request makes this code unavailable.

What it means: Pomegr observed a tool/result → provider task notification → directly resumed request sequence at the same occurrence where Claude reported changed message history and Pomegr observed possible full-refill evidence.

What it does not prove: the notification caused the divergence, the exact outgoing API request was mutated, a stale tool result was substituted, or the provider charged any amount. Claude Code transcripts do not contain consecutive serialized outgoing request bodies, so those stronger claims are not recoverable from this evidence alone.

Privacy: browser state contains only the fixed sequence enum and stable public code. Tool names, tool-use IDs, task IDs, notification content, message IDs, prompts, results, and transcript paths remain monitor-private.

Provider scope: Claude Code transcript evidence. Other adapters must independently prove an equivalent normalized sequence before emitting this code.

Related public investigation: [anthropics/claude-code#88444](https://github.com/anthropics/claude-code/issues/88444) and [the standalone resume-session reproducer](https://gist.github.com/justprosh/4ff59eea486fb4865c604f2a4748d888/eb1cf7164ccd7f4bf23bdc3471106808f44b1698).
