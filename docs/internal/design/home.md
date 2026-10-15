# Home design

> Scope: the Home page and its What's new card and dialog.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/home/`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

This page covers Home and the What's new announcement.

## Home

- Home is a personal starting point for last-viewed and pinned destinations.
- Its sections collapse to one column and keep the reading order.
- It keeps bounded, identity-only local preferences.
- It shows honest unavailable and coming-soon content.

## What's new card

`HomeUpdateCard` is a teaser. It is not the announcement itself.

### Content

- A 132×84 thumbnail.
- An uppercase caption eyebrow in brand text.
- A 14px/650 title.
- One muted 12px summary line.
- A [Secondary](../../../DESIGN.md#buttons) **See what's new** action.
- An icon dismiss.

## What's new dialog

### Layout

- The **See what's new** action opens a modal `<dialog>`.
- The panel is 560px wide and centered, with the overlay shadow.
- The backdrop is `#0008`, the same scrim as the phone agent-filter sheet.
- On the phone, the dialog is a bottom sheet.

### Content

- The illustration on the raised fill (`--command-panel-2`).
- The same eyebrow as the card.
- A 16px/650 title.
- The description.
- Short muted highlights.
- A [Primary](../../../DESIGN.md#buttons) **Got it**.

### States

- **Got it**, the icon close, Escape, and a backdrop click close the dialog and keep the card.
- Closing the dialog returns focus to the trigger.
- Only the card's icon dismiss dismisses the announcement.
- The dialog opens by itself once for each announcement, the first time Home renders it.
- Pomegr records that opening when the dialog opens.
- After that, the dialog opens only on the **See what's new** action. This holds whether it was closed or the page reloaded.
- The automatic opening waits 300ms after Home renders, so the entrance does not compete with first paint.
- The privacy rules for the stored markers are in [Desktop and diagnostics](../architecture/privacy/desktop-and-diagnostics.md#home-announcement-markers).

### Motion

- The entrance is one unhurried ease-out moment.
- Reduced motion removes the entrance.
- The panel fades in and rises 12px over 600ms. It does not scale.
- The backdrop dims on the same gentle curve.
- The phone sheet rises 32px.

## Illustration

- `HomeUpdateIllustration` is decorative static artwork.
- It is built from tokens and sample data.
- It is authored 408px wide.
- The card thumbnail scales the same node down.
- Both copies are inert and hidden from assistive technology.
- An announcement without an illustration renders text only.
- It never reads session state.
- It never ships a screenshot.

## Samples

- `/design-system` renders both forms: the card and the dialog.
