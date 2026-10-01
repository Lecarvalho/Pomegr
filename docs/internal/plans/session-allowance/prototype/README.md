# Session allowance prototype

Standalone exports of the design canvas approved on 2026-09-21 for the
[session allowance plan](../../session-allowance.md). These are reference
drawings with hard-coded dark-theme values and inline styles. Do not copy their
markup or colors; use the existing classes and the tokens in
`app/styles/tokens.css`. Every number is illustrative.

Live canvas (editable, requires claude.ai access): https://claude.ai/artifact/YcQYuA2NX3H2S1AQC4sMAp

## Artboards

- [1 · Overview: Allowance beside Cost](OverviewAllowance.dc.html)
- [2 · Details: compact Allowance movement under Cost estimate](DetailsAllowance.dc.html)
- [3 · Usage limits: tier chip and sessions in this window](UsageLimitsSessions.dc.html)
- [4 · Overview panel states](AllowanceStates.dc.html)

The blue outline marks what is new on each artboard. It is a drawing aid and
must not ship.

## Viewing

Serve this folder and open an artboard; some browsers block the scripts over
`file://`. From the repository root:

```powershell
npx --yes http-server docs/internal/plans/session-allowance/prototype -p 8099
```

`support.js` and `vendor/react*.js` are the runtime that renders the artboards;
they are not part of the design.

## What the drawings cannot show

- The unit is always **pts** (percentage points of the account window), never
  `%` of the session. The window's own level keeps `%`.
- The stacked bar is scaled to the whole window (0 to 100). Its segments are, in
  order: before this session, this session alone, shared intervals, no local
  request. Meaning never depends on color alone: every bar has a text line
  carrying the same numbers.
- Amber appears only in the **Account used elsewhere** state. All other states
  use ink and grey.
- The sample chart from the first draft of artboard 2 was removed on the user's
  request. The Usage limits page keeps the only timeline.
- No phone artboard exists. The plan states the phone rule.
- The plan's 2026-09-30 revision added three things that are not drawn: request
  tokens by agent and model inside a session, past windows on the Usage limits
  page, and an optional estimated split of shared intervals. Each needs the
  user's approved layout before it is built.
