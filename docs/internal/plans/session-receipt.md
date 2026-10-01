# Session receipt: a picture of one session to share

> Status: proposed; direction chosen by the product owner on 2026-09-30 on the design canvas, no code written.
> Created: 2026-09-30.
> Scope: let a user turn one session's numbers into a PNG they can copy or save, made on their own computer with nothing uploaded. Covers what the picture shows, its privacy defaults, how it is rendered, and where the action lives. Excludes a weekly picture, a pull-request comment, and any hosted sharing.
> Design canvas: https://claude.ai/artifact/UR3KnUBSnmJqnMwarWEhSR (private to the owner). Row C, **Compact calm**, is the chosen direction; rows A and B are earlier directions the owner moved away from. The rules below win where a drawing differs.
> Continuation owner: the agent that picks up this plan in a fresh session; the owner reviews the result against row C.
> Authority: working proposal. `AGENTS.md` and `DESIGN.md` stay authoritative; task 1 changes them.
> Next task or decision: the open decisions below, then task 1.
> Completion criteria: every task ticked with its verification recorded, the picture matches artboards C1 to C4 apart from the written differences, `npm run build` and `npm test` pass, and the feature has a public guide.
> Permanent destinations: `AGENTS.md` (what the picture may contain), `DESIGN.md` and `/design-system` (the dialog and any new shared control), [Metrics](../architecture/metrics.md) (the label rules), and `docs/public/using-pomegr/` (user guide).
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Why

Developers try tools their peers post about. Pomegr has nothing a user would post today. A calm, good-looking picture of one session gives them something to share. The picture is about the user's session, not about Pomegr: the mark and name are present but quiet, by the owner's decision on 2026-09-30.

## The chosen design

The owner asked for a serious, calm, minimal picture and chose the compact version. All values below describe row C on the canvas.

| Property | Value |
| --- | --- |
| Size | 800 × 400, exported at double resolution (1600 × 800) |
| Light ground, ink, muted text, hairline | `#f0ece2`, `#171715`, `#5a554b`, `#c9c2b2` |
| Dark ground, ink, muted text, hairline | `#111112`, `#f0ece2`, `#a39d90`, `#3a3838` |
| Display type | Rokkitt regular: 52px for figures, 24px for the session name, 19px for the wordmark |
| Label and note type | Geist Mono, 11 to 13px |
| Color accent | None. The painted mark and the wordmark are drawn like a watermark: the muted text color at 45% opacity |

These are the landing site's paper palette and display face, not the app tokens. The picture is a marketing surface; task 1 records that exception in `DESIGN.md`.

Layout, top to bottom:

1. Header: the painted mark and **Pomegr** on the left, small and faint like a watermark; **Session receipt**, the provider, and the date on the right.
2. The session name, on one or two lines.
3. One strip of five figures, each with a small label above and a short note below.
4. One thin line for the agents: one small dot per agent, with the model mix beside it.

There is no footer. The owner removed the web address and the **Measured on this computer** line on 2026-09-30.

The five figures and their notes, with the examples drawn on the canvas:

| Label | Note | Big session | Small session |
| --- | --- | --- | --- |
| Agents | one dot each | 40 | 1 |
| Wall time | idle gaps included | 10h 11m | 30m 54s |
| Requests | recorded | 1,990 | 69 |
| Tool calls | failed count | 2,325 | 84 |
| Files edited | new files, or commits on the branch | 81 | 8 |

Those numbers are real values from two of the owner's sessions on 2026-09-30 and are examples only.

## Rules the drawings cannot show

- A figure or note appears only when its evidence exists. A missing value is left out; it is never shown as zero or a dash.
- Every label keeps the product's honesty rules: wall time includes idle gaps, requests are the recorded ones, and files edited counts recorded edits by structured file tools, not every change in the repository.
- The picture is built only from normalized values the browser already receives. It never contains a prompt, response, command, file name, path, or transcript text.
- Nothing is uploaded. The PNG is made in the user's browser or desktop window.

### What shows by default

| Element | Default | Decided |
| --- | --- | --- |
| Session name | On | Owner, 2026-09-30 |
| Repository and branch | Off | Opt-in; a repository name can identify a client or employer |
| Cost estimate | Off | Owner doubted on 2026-09-30 that people would share a dollar figure. When on, it is one small line reading "Claude Code estimate at API list rates. Not a bill." |
| Model mix on the agents line | On | Proposed; needs the owner's confirmation in task 1 |

A session name can itself name a feature or a client. The dialog keeps a checkbox to turn it off.

## Open decisions

1. Light or dark as the default picture. Proposal: follow the app theme the user has selected.
2. Whether the model mix may appear. Some surfaces keep model identifiers private; the picture would show only family names and counts.
3. Whether one of requests or tool calls gives way to commits or, once the [session allowance plan](session-allowance.md) ships, allowance points.

## Work and verification

### Task 1 — Contracts

- [ ] `AGENTS.md`: add what a session receipt may contain (the fields above and nothing else), that it is rendered locally and never uploaded, and the defaults table. If the model mix is approved, state that only a bounded family label and a count appear.
- [ ] `DESIGN.md`: record the picture as a marketing surface that uses the paper palette and Rokkitt, and persist the exception as the design contract requires.
- [ ] [Metrics](../architecture/metrics.md): the label rules above.

Acceptance: `git diff --check` is clean and `npm run verify:fast` passes.

### Task 2 — The receipt model

- [ ] Add one pure function that turns the session-summary, agents, and repository domains into a receipt model: the header, the optional name, the figures with their notes, the agent count and mix, and the optional lines. It decides which figures have evidence. Place it with the dashboard utilities and keep it free of DOM code.
- [ ] Tests: the big and small examples, a session with no repository, a historical session, missing evidence leaving a figure out, and a sentinel check that no path or file name can enter the model.

Acceptance:

```powershell
npm run test:ui
```

### Task 3 — Render the PNG

- [ ] Draw the picture from the model on a canvas element at double resolution and export it with `toBlob`. Drawing directly avoids the font and layout differences of converting page markup to an image.
- [ ] Fonts: the app already loads Geist Mono. Rokkitt ships only with the landing site (`landing/public/fonts/rokkitt-variable.ttf`); add it to the app for this surface, check its license notice is carried, and wait for both fonts before drawing.
- [ ] The mark: draw `public/pomegr-mark-painted.png` through the same luminance mask the header uses, in the muted text color for the chosen ground.
- [ ] Tests: the drawing calls for each element given a model, the two themes, and the opt-in lines. A pixel comparison is not required.

Acceptance:

```powershell
npm run test:ui
```

### Task 4 — The dialog and the action

- [ ] Add a quiet **Share receipt** action beside **Download report** on the session page. It opens a dialog with the live preview, the checkboxes (**Session name**, **Repository and branch**, **Cost estimate**, **Models used**), the line **Made on this computer. Nothing is uploaded.**, and the buttons **Copy image** and **Save PNG**. Artboard 4 in row A draws the dialog.
- [ ] **Copy image** uses the clipboard image API, which browsers allow only in a secure context. The dashboard reached over the local network by plain HTTP is not one, so hide **Copy image** there and keep **Save PNG**. The desktop app and `localhost` keep both.
- [ ] Remember the checkbox choices per browser, not per session.
- [ ] Every button uses an existing role. Add a `/design-system` sample for the dialog and update the contract test.
- [ ] Phone layout: the preview above the controls, full-width buttons.
- [ ] Tests: defaults, each checkbox changing the model, the hidden copy button outside a secure context, and the saved file name carrying no session name unless the name is on.

Acceptance:

```powershell
npm run test:ui
```

### Task 5 — Close

- [ ] Write the public guide with one real example picture, following the screenshot ownership rules in the [maintenance workflow](../development/documentation.md).
- [ ] Run `npm run build`, `npm test`, and `npm run lint`, one after the other.
- [ ] With the app running, confirm by hand: both themes, a big and a small session, a pasted image in a chat tool, and that the network tab shows no request when a picture is made.
- [ ] Apply the closure procedure and delete this plan.

## Later, not in this plan

- A weekly picture ("what this week looked like"). It needs history that survives restarts; see the [durable session store plan](durable-session-store.md).
- Posting the receipt as a pull-request comment.

## Continuation checkpoint

2026-09-30: three directions drawn on the canvas with two real sessions. The owner rejected the first as boring, found the paper receipt too loud, chose the calm direction, asked for it smaller, asked for the session name to show, then asked for the mark and name to be muted, then fainter like a watermark, and the footer removed. The old vector logo was removed from the repository the same day so it cannot be picked up again; the painted mark is the only mark. Next action: the open decisions, then task 1.
