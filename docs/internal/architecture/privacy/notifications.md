# Notification privacy

> Scope: what the notification feed, its private stores, and the desktop notification settings may hold or expose.
> Authority: canonical privacy invariants for this subject. Behavior detail is in [Shared notifications](../observation-cache.md#shared-notifications).
> A change that widens exposure changes this page in the same pull request.

## Notification response

The notification response has a fixed shape.

**May expose only:**

- Version, monotonic revision, and generation time.
- Catalog/provider-status readiness.
- A bounded active-session overflow count.
- Occurrences. Each occurrence has:
  - an opaque ID;
  - fixed kind, category, severity, lifecycle, action, and time-basis values;
  - a bounded priority;
  - the original occurrence time;
  - delivery eligibility;
  - a normalized provider or null;
  - narrow kind-specific data.

**Kind-specific data:**

- `needs_input` carries only a validated normalized session ID and a bounded catalog title.
- Release news carries only the fields that [Release notifications](#release-notifications) lists.
- Provider incident/recovery carries only a fixed health status.
- Client-local `monitor_unreachable` carries no data.

**Identity:** an active status or title update preserves the occurrence identity and the
original time.

**Never crosses the boundary:** private comparison keys, source scopes, provider payloads,
paths, credentials, prompts, commands, errors, and arbitrary URLs.

**Actions:**

- Actions map to fixed local destinations.
- A release occurrence also gets a **What's new** link. The client derives it from the
  product and the version. It is not an action, and it is never stored.
- Actions cannot approve work, authenticate, install, or change a provider.
- A native `needs_input` click also asks the desktop to bring the session's own window to
  the front. It hands the shell only the validated session ID and bounded title already
  in the occurrence. [Session window focus](desktop-and-diagnostics.md#session-window-focus)
  owns what that action may read and do.

**Stores:**

- Durable monitor baselines and native delivery claims stay in separate private,
  versioned, bounded atomic stores.
- Routine writes cannot overwrite a malformed or newer store.
- Native delivery claims an occurrence before OS dispatch. A crash can therefore lose a
  toast.
- Browser-local read markers hold only bounded opaque IDs and times, for 30 days.
- Read markers never hold titles or source fingerprints.
- Reading does not resolve a condition. Reading does not synchronize with native delivery.

Behavior: [Observation cache](../observation-cache.md)

## Desktop notification settings

- Desktop notification settings persist only the existing `notifications` boolean and the
  fixed `notificationCategories` booleans (`attention`, `provider_news`, `model_news`).
- These settings live in private desktop settings.
- One-hour quiet remains memory-only.
- New news categories default off.
- Only a trusted main-frame, fixed-key IPC handler can change these settings.
- Browser/LAN clients cannot mutate these settings.
- The desktop's committed-feed reader rejects HTTP redirects before it sends local
  authorization elsewhere.
- Notification actions stay on fixed local routes.

## Usage notifications

**Derivation:**

- Usage notifications derive only from fresh, complete, comparable committed account
  observations.
- A clock crossing alone never confirms a reset.

**Fixed kinds:**

- `usage_window_reset` and `usage_capacity_restored` carry only a fixed window key, a
  `provider_api`/`local_observation` origin, and an `otherExhausted` boolean.
- `usage_reset_available` carries only a bounded positive Codex available count.
- All three use the fixed `usage` category and the `open_usage_limits` action.

**Reset credits:**

- Account usage may additionally expose `resetCredits`.
- `resetCredits` holds a supported/unknown status, a count of 0–1000 or null, and the
  original observation time.
- Missing/null is unknown.
- Availability is never redemption eligibility.
- Never retain or expose credit IDs, titles, descriptions, or redemption payloads.
- Never consume a reset.

**Private comparison state** holds at most one baseline per provider. A baseline holds only:

- an opaque credential-source filesystem scope;
- a fixed origin;
- the original time;
- an opaque window-set digest;
- at most sixteen normalized windows, each with a fixed display key, an opaque stable
  identity, a percentage, an exhaustion flag, and a reset time;
- a nullable bounded count.

Comparison rules:

- Out-of-order evidence cannot rewind a baseline.
- Stale, partial, or unknown evidence breaks comparisons.
- A source change breaks comparisons.

**Authentication required:**

- The fixed `usage_authentication_required` kind carries empty data.
- It uses `provider_news` (native Provider updates opt-in, default off).
- It has warning severity and the same fixed Usage limits action.
- Its private per-provider baseline holds only an opaque scope, the last attempt and retry
  times, and a notified flag.
- Only a later fresh recognized authentication-required attempt after its normal retry can
  emit, once.
- Transient or generic failures never qualify.

Behavior: [Observation cache](../observation-cache.md)

## Release notifications

**Sources:**

- Release notifications derive from bounded official public release reads or from already
  committed current repository plugin setup.
- Claude Code GitHub releases prove latest-channel publication only. They do not prove
  stable-channel availability.
- OpenAI's own Codex `channels/latest` metadata with a stable `rust-v` tag covers Codex CLI
  only. It never covers the desktop app or IDE extension.
- A historical transcript version is never proof of the current installation.

**Persistence:** for each of Claude Code, Codex CLI, and the Pomegr reporting plugin, the
monitor may persist at most:

- one normalized version;
- one fixed channel;
- the original observation time;
- for Claude Code only, an optional release excerpt.

**Public release occurrences** carry only:

- a fixed product/channel;
- a validated semantic version;
- an optional bounded affected-repository count;
- for Claude Code only, an optional release excerpt.

**Release excerpt** (deliberate widening, task T-121, approved by the owner on 2026-10-15):

- The Claude Code parser reads the `body` of the newest valid GitHub release row, within the
  reader's existing 1 MiB response limit.
- The parser makes the excerpt and drops the body. No raw body leaves the parser.
- The excerpt is plain text from the first six content lines. Headings, code blocks,
  images, link targets, bare URLs, HTML, entities, and control, zero-width, and
  bidirectional characters are removed. Link text stays.
- The excerpt is one line of at most 280 characters. A longer excerpt is cut at a word
  and ends with an ellipsis.
- Every store and client accepts an excerpt only when it has no `<`, `>`, `://`, or
  `www.`, no control character, and no more than 280 characters. A row with any other
  excerpt is refused.
- A baseline or occurrence without an excerpt stays valid.
- Codex CLI and the plugin have no excerpt: their sources supply no notes. Pomegr adds no
  fetch for Codex notes.

**Release page link** (same widening):

- The client derives the page from the product and the validated version with a fixed
  template: `https://github.com/anthropics/claude-code/releases/tag/v<version>` and
  `https://github.com/openai/codex/releases/tag/rust-v<version>`.
- No URL is read from a payload or stored. The plugin has no link.
- The desktop external allowlist admits exactly these two path shapes, with no query or
  fragment. It refuses every other release path.
- A paired device shows the excerpt and the link the same way as the desktop.

**Wording:**

- Current comparable plugin setup may qualify an update message.
- Unknown installation yields publication wording.

**Never in notification state or durable stores:** private repository IDs, source keys,
full or raw release bodies, URLs, paths, and provider payloads.

**Scheduler:**

- One low-priority bounded six-hour scheduler owns public release reads.
- Conditional responses, fixed endpoint/redirect denial, deadlines, size/item limits, and
  retry backoff cannot block live observation or GET serving.

**Actions:**

- Native and browser actions remain fixed local navigation. They never run an install,
  download, or provider command.
- The native toast shows the excerpt as its body, cut to the 200-character native limit.
  A click opens the local Usage limits route.
- The tray's **What's new** link opens the derived release page in a new window, so the
  desktop shell applies its external allowlist.

## Model notifications

**Distinct evidence:** model notifications keep official announcements, client catalogs,
and account entitlement distinct.

**Announcements:**

- Only bounded exact OpenAI RSS introduction/retirement titles qualify as announcements.
- Other titles stay unavailable.
- Claude news and catalogs stay unavailable.

**Catalogs:**

- Codex model/list may be bundled or cached. It never proves entitlement.
- Complete bounded pagination precedes commit.
- Hidden/alias IDs, stale/partial data, and source switches cannot manufacture new
  availability or retirement.

**Notifications may expose only:**

- a validated model identifier (120 characters);
- a safe label (64);
- the fixed `official_announcement`/`client_catalog` evidence;
- `model_news`;
- a fixed local action;
- the publication/observation time.

**Private per-provider catalog/news baselines** hold only:

- an opaque effective-home/auth/config scope;
- the original time;
- at most 256 normalized known IDs or publication digests.

**Never persist:** raw XML, bodies, URLs, configuration, and credentials.

**Scheduler:**

- One low-priority source scheduler owns hourly catalog reads and six-hour news reads.
- This feature introduces no GET, provider conversation, paid inference, entitlement probe,
  or control operation.

Behavior: [Observation cache](../observation-cache.md)
