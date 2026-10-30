# Provider and account privacy

> Scope: what Pomegr may read, keep, send, or expose about provider accounts, credentials, processes, and plugins.
> Authority: canonical privacy invariants for this subject. Behavior detail is in [Observation cache](../observation-cache.md) and [Claude Code session status](../claude-session-status.md).
> A change that widens exposure changes this page in the same pull request.

## Claude status-line cost and local usage feed

**Cost capture may persist and expose only:**

- the normalized session ID;
- a non-negative `total_cost_usd`;
- a USD currency label;
- the estimate type;
- the local observation timestamp.

Always present the value as a Claude Code estimate, not as authoritative billing.

**The separate local usage feed may persist only:**

- a version;
- a local observation timestamp;
- a complete pair of normalized five-hour/seven-day percentages and reset timestamps.

**Rules:**

- Never persist any other status-line fields.
- Expose only normalized usage windows, bounded origin/freshness enums, and the original
  observation time.
- Repeated identical output must not renew freshness.

## Claude account-usage recovery

**Account-usage recovery may separately persist only:**

- a version;
- an opaque credential-source filesystem fingerprint;
- the original successful-observation timestamp and the last-attempt timestamp;
- a bounded failure kind;
- a retry deadline;
- the three recognized normalized usage windows. Each window holds a fixed ID, a
  percentage, a reset timestamp, and an active flag.

**Rules:**

- Restore only for the same credential source.
- Reconstruct labels and severity.
- Never persist credential contents, credential paths, account IDs, raw responses,
  headers, or error text.
- Keep the status-line pair separate.
- Preserve original ages and provider cooldowns across restarts.
- Never expose this cache or its source fingerprint through browser state.

Behavior: [Observation cache](../observation-cache.md)

## Claude five-hour rejection time

- Claude five-hour rejection metadata may expose only the earliest normalized local
  rejection timestamp, matched monitor-side to the current reset window.
- Never expose raw quota payloads.
- Never describe that timestamp as the authoritative instant the provider exhausted the
  account.

## Codex native writer presence

**Scope:**

- Codex native writer presence is read-only and monitor-private.
- On Windows, confirm all of the following before you assert presence:
  - byte-range contention;
  - stable file identity;
  - a unique native process owner;
  - an allowlisted executable path;
  - matching process-start identity.

**Retention:**

- Retain only bounded in-memory ownership and confirmation state.
- Never persist or expose lock paths, executable paths, PIDs, process identities, helper
  output, or errors in browser state.
- Lock reads stay in the observation. Never retain or expose them.

**Meaning of ownership:** ownership establishes presence. It does not establish executing
work or completion.

**Released writer** (as approved by the product owner on 2026-09-28): unresolved recorded
work is live only while a writer could still resolve it.

- The condition: the lock directory exists, and the thread's lock and its root's lock are
  both missing or uncontended at observation.
- Under this condition, the work is never live. It shows as Unknown with liveness reason
  `writer_released`. It is never shown in Live and then removed.
- A recorded failed or interrupted turn (Stopped) with the same unowned, released-lock
  condition keeps its Stopped status. It gains only the reason `writer_released`.
- This reason is what lets the task board stall a Codex task. Stopped without it never
  does.
- Release never establishes completion, idle, stopped, or success.
- Release never outranks an owning runtime or a confirmed owner.

**Forbidden in presence observation:**

- Consume lifecycle hook snapshots or leases.
- Write provider files.
- Attach a worker.
- Control provider processes.

The separate task dispatcher starts new sessions. It never uses presence to act on an
existing one.

**Other platforms** require separately validated native semantics. No plugin fallback is
implied.

## Session-observed plugin metadata

**Pomegr plugin metadata may expose only:**

- an exact bounded plugin version;
- a recognized policy status and version;
- a transcript-derived observation timestamp, from a provider-owned SessionStart hook
  marker.

**Rules:**

- Never accept user-authored lookalikes.
- Never expose surrounding hook or policy content.
- Never treat an absent observation as proof that the plugin is uninstalled.
- Historical views must preserve the session-observed values.

## Current repository plugin setup

Current repository plugin setup is a separate read-only observation of local installation
records, resolved manifests, and effective provider configuration.

**May expose only:**

- bounded installation/readiness/enablement/scope enums;
- installed and available versions;
- original check times;
- update status;
- action availability;
- shared reporting-policy status/version.

**Rules:**

- It must never replace session-observed plugin metadata.
- Raw configuration, paths, provenance, and policy content remain private.
- Plugin install/update actions require all of the following:
  - an explicit native desktop confirmation;
  - a revalidated official source/scope/version plan;
  - fixed CLI arguments;
  - a fresh local verification.
- Browser/LAN GETs cannot trigger these actions.

Behavior: [Observation cache](../observation-cache.md)

## OAuth credentials and Remote Control status

**Send OAuth credentials only to:**

- the provider's authenticated usage endpoint;
- for locally registered Claude Remote Control sessions with a validated process owner, the
  read-only `GET https://api.anthropic.com/v1/code/sessions/{id}` metadata endpoint.

**This status exception never permits:**

- remote discovery;
- event reads;
- worker attachment;
- control actions;
- token refresh;
- redirects.

**Retention:**

- Keep remote IDs, credentials, payloads, and errors monitor-private.
- Retain only normalized lifecycle and local observation time.

Behavior: [Claude Code session status](../claude-session-status.md)

## External usage requests

- Cache external usage requests.
- Sanitize failures.

## Desktop account sign-in

- Claude Code and Codex sign-in require trusted desktop IPC and explicit native confirmation.
- Each action accepts no renderer arguments and launches its installed native CLI with fixed arguments and no shell.
- Codex launches `codex login`; the CLI owns browser authentication and credential storage.
- Child input and output are ignored; login output never enters browser state, API responses, or logs.
- The renderer receives only `completed`, `cancelled`, `failed`, `unavailable`, `busy`, or `timed_out`.
- Credentials, executable paths, environments, raw failures, and login URLs remain private.
- Browser and paired-device clients cannot launch sign-in; no HTTP control route exists.
- A successful CLI exit requests a separate asynchronous usage check and proves neither usage availability nor provider health.

Behavior: [Observation cache](../observation-cache.md#local-claude-usage-observations-and-desktop-recovery)

## The Jev key

The owner may set a Jev key so that Aril's chat can ask Jev, a third-party model service, to lower the effort of a simple reply ([Effort routing](../agent-chat.md#effort-routing)). The key is the only credential of the owner's that Pomegr itself keeps.

**Storage:**

- Desktop main stores the key in one file under the desktop data root (`jev-key-v1.bin`), encrypted with Electron's `safeStorage`, which uses the operating system's store.
- Where the operating system offers no encryption, or only a weak backend, nothing is stored. The option stays off, and the key is never written as plain text.
- The key is also held in desktop main's memory, once read, for the call below.
- The owner removes it in the Aril section of Settings, which deletes the file and the copy in memory.

**Who can set it, remove it, or ask about it:**

- The trusted desktop window only, on the channel `pomegr:agent-chat-jev`, with the operations `status`, `set`, and `remove`.
- The renderer holds the key only while the owner types it into a masked field. It is sent once, the field is emptied once the key is saved, and no answer returns it: the renderer learns only `set`, `unset`, or `unavailable`.
- A paired device has no route to it and cannot set, remove, or see whether one is set. A browser on the same computer has none either.

**Where it goes:**

- The `Authorization: Bearer` header of one `POST https://api.typesafe.ai/v1/systemone`, made by desktop main for an owner message (with what the call sends, in [Agent chat: Privacy](../agent-chat.md#privacy)). Nothing else sends it anywhere.
- Never the monitor, a task or conversation file, a prompt, a provider process (argument, environment, or MCP server), a log, a notification, diagnostics, a report, a checkpoint, an error text, or browser storage.
- A timing keeps only a time and a fixed word about the call.
