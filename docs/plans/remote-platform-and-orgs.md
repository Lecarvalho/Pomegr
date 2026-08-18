# Pomegr remote platform, mobile clients, and organizations plan

> Working document: this records the agreed direction for making Pomegr a self-contained,
> multi-device product. It consolidates the platform vision referenced by
> `docs/COMMERCIAL_STRATEGY.md`. Nothing here is shipped; milestones are ordered
> hypotheses, not commitments.

## Objective

Evolve Pomegr from a single-PC, LAN-only observer into a self-contained product that a
user installs on one or more PCs and monitors from anywhere — including native Android
and iOS apps — without configuring VPNs, tunnels, or router port forwarding. The same
platform must later support organizations observing their developers' coding-agent
sessions under Pomegr's existing privacy invariants.

Everything in this plan preserves the non-negotiable boundaries in `AGENTS.md`:

- Raw prompts, responses, commands, tool output, transcripts, and credentials never
  leave the developer's machine.
- The privileged monitor stays bound to loopback; only normalized, bounded metadata
  crosses any network boundary.
- OAuth credentials are sent only to the provider's authenticated usage endpoint, from
  the machine that owns them.
- Monitoring stays read-only. Control actions require a future explicit confirmation
  boundary.

## Problems this plan answers

1. **Remote access is not self-contained.** Today the dashboard binds to `0.0.0.0:3003`
   and is reachable only on the local network. Remote viewing requires the user to bring
   their own overlay network (for example Tailscale). That works for development but is
   not a product answer: it depends on third-party accounts, phone VPN slots, and network
   conditions Pomegr cannot see or fix.
2. **Multiple PCs on one subscription duplicate provider polling.** Two PCs running
   Claude Code under the same subscription each run a Pomegr monitor, and each monitor
   independently polls the provider's usage-limit API. The duplicated schedules produce
   `429` rate-limit errors. `monitor/usage-limits.mjs` already uses a five-minute refresh
   interval, a single-flight cache, and honors `Retry-After` on `429`, but nothing
   coordinates *across machines*.
3. **Native mobile apps are planned.** Android and iOS apps are the intended remote
   clients; the browser dashboard on a phone is a temporary bridge. Native apps need a
   stable backend API and enable real push notifications, which a locally served page
   cannot provide.
4. **Organization visibility is part of the product vision.** Organizations should be
   able to observe their developers' coding-agent sessions (the Teams and Enterprise
   editions in `docs/COMMERCIAL_STRATEGY.md`). A purely local, peer-to-peer design
   cannot deliver fleet views, role-based access, or retention controls.

## Transport options evaluated

| Option | Verdict | Reasoning |
| --- | --- | --- |
| LAN only + installable web app | Baseline, not the milestone | Zero infrastructure, but unusable away from the local network — the exact limitation being solved. |
| User-supplied overlay network (Tailscale, WireGuard) | Interim dev tool only | Works today for the maintainer, but depends on third-party accounts, the phone's single VPN slot, and failure modes outside Pomegr's control (dead Wi-Fi captive portals black-hole the tunnel). Not self-contained. |
| **Pomegr relay backend (outbound connection from the PC)** | **Chosen direction** | The monitor host opens an outbound WebSocket to a Pomegr-operated backend; phones connect to the same backend. Works behind any NAT/CGNAT/roaming with zero user network configuration. Standard pattern for install-on-PC, view-on-phone products. Cost: Pomegr operates infrastructure and owns its availability. |
| Peer-to-peer direct (WebRTC/Iroh) with signaling server | Later optimization | Best privacy and lowest relay bandwidth, but NAT traversal fails on a meaningful fraction of networks, so a relay fallback must exist anyway. Build after the relay, not instead of it. |
| Embedded overlay network (tsnet + self-hosted Headscale) | Rejected | White-labeling a VPN inside Pomegr requires a Go sidecar beside the Node monitor, an operated coordination server, and VPN permission prompts on phones. Disproportionate for read-only metadata viewing. |

## Target architecture

```
┌──────────────── developer PC ────────────────┐
│ provider session files (raw, never leave)    │
│        │                                     │
│  monitor (loopback only) ── normalization ── │──▶ outbound WebSocket ──▶ ┌─────────────┐
│        │                                     │      (normalized,        │   Pomegr    │
│  local dashboard (LAN)                       │       bounded metadata   │   backend   │
└──────────────────────────────────────────────┘       only)              └──────┬──────┘
                                                                                │
                                                            ┌───────────────────┼──────────────┐
                                                            ▼                   ▼              ▼
                                                      Android app           iOS app       org dashboard
```

### Node agent (per PC)

The existing monitor remains the privileged, loopback-bound component. A thin sync
agent beside it maintains one outbound WebSocket to the backend and pushes the same
normalized state the local dashboard already consumes. Nothing new crosses the
serialization boundary: if a field is not safe for the local browser API, it is not
safe for the backend either. When the backend is unreachable, the local dashboard is
unaffected — remote visibility degrades independently, matching the provider-failure
degradation rule.

### Pomegr backend

- **Identity:** personal accounts; each PC is enrolled as a device.
- **Device pairing:** the PC displays a QR code or short code; the phone scans it to
  bind the device to the account and receive a per-device token. The PC remains the
  authority that grants access; no passwords are stored for pairing.
- **Fan-in:** sessions from all of a user's PCs appear in one timeline.
- **Fan-out:** live state streams to mobile apps and, later, org dashboards.
- **Poll-lease coordination:** see the dedicated section below.
- **Push notifications:** APNs and FCM delivery for attention states, stuck sessions,
  and usage-limit warnings — the primary reason native apps beat a served web page.

### Clients

- **Local web dashboard:** unchanged; remains the development surface and the LAN view.
- **Native Android and iOS apps:** consume the backend API only; never talk to a PC
  directly. The phone-served browser dashboard is a temporary bridge until they ship.
- **Org dashboard:** a backend-served web view scoped by role (see Organizations).

## Usage-limit polling coordination (the 429 fix)

Credentials never leave the PC, so the backend cannot poll the provider itself.
Instead the backend coordinates *which* machine polls:

1. Each agent reports the provider account it observes as a salted hash — the raw
   account identifier is never sent.
2. The backend grants a time-boxed **poll lease** per account hash to exactly one
   connected agent.
3. The leaseholder polls locally with its own credentials, then pushes the normalized
   usage-limit snapshot (already a non-secret shape) to the backend.
4. The backend fans the snapshot out to the user's other agents and clients, which
   suppress their own polling while a fresh leased snapshot exists.
5. If the backend is unreachable or the lease lapses, every agent falls back to
   independent local polling with jittered schedules — never worse than today.

Interim, backend-free mitigations (Milestone R1) reduce collisions between two PCs
sharing a subscription:

- Exponential backoff on repeated `429` responses (the current reader retries at a
  fixed interval once `Retry-After` expires).
- A per-machine phase offset derived from a stable machine identifier, plus schedule
  jitter, so two monitors polling every five minutes stop aligning.

## Organizations

Organization visibility is a first-class goal with a strict framing: Pomegr's
commercial advantage is that the observed data *cannot* contain prompts, source code,
commands, or credentials, by construction. The org layer must strengthen that story,
never dilute it.

- **Structure:** organization accounts; members join with their personal account;
  devices bind to members; org policy controls which normalized fields are reported.
- **Roles:** members see their own sessions; managers see team aggregates; admins
  manage policy, retention, and membership.
- **Transparency and consent:** the agent surfaces a visible indicator whenever org
  reporting is active, and the exact reported field list is user-inspectable. Silent
  monitoring is a non-goal; data minimization is the selling point for GDPR and
  works-council review.
- **Encryption honesty:** personal-scope data can be end-to-end encrypted between a
  user's own devices (keys exchanged during pairing, backend forwards ciphertext).
  Org-scope data is readable by the org by design — that is the product — and the
  documentation must say so plainly rather than claiming E2EE everywhere.

## Milestones

Numbered `R` (remote platform) to stay distinct from the desktop `POMEGR-DT` tasks.

- **R1 — Cross-machine 429 mitigation (no backend).** Add exponential backoff,
  jitter, and machine-derived phase offset to `monitor/usage-limits.mjs`. Small,
  shippable immediately, and still the fallback path after the backend exists.
- **R2 — Device pairing and auth.** QR/short-code pairing, per-device tokens, and a
  token check in the Next.js API proxies. Transport-agnostic: secures the LAN
  dashboard today and becomes the backend enrollment mechanism later.
- **R3 — Backend v1.** Accounts, device enrollment, normalized-state ingest over
  outbound WebSocket, live fan-out, and poll leases. This is the self-contained
  product milestone: install Pomegr, scan a code, see metrics anywhere.
- **R4 — Native mobile apps.** Android and iOS clients on the backend API with APNs/FCM
  push notifications. Retires the phone-browser bridge.
- **R5 — Organizations.** Org accounts, roles, team dashboards, retention controls,
  and the consent/transparency surface. Aligns with the Teams edition hypothesis.
- **R6 (optional) — Peer-to-peer direct path.** WebRTC data channels with the relay
  as fallback, cutting backend bandwidth and latency.

## Open questions

- Backend hosting: managed multi-tenant first, or self-hosted from day one for
  Enterprise prospects (`docs/COMMERCIAL_STRATEGY.md` raises the same question)?
- Account-hash salting scheme for poll leases that prevents cross-user correlation
  while still deduplicating within one subscription.
- Whether R2 pairing should also gate the LAN dashboard by default or remain opt-in
  until the backend ships.
- Retention defaults for backend-stored normalized state, per edition.
- How org policy interacts with a member's personal devices observing the same PC.
