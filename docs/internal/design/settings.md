# Settings design

> Scope: the Settings sections Providers, GitHub, Storage, and the storage usage meter, plus the About pane.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/settings/`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

This page states how each Settings section looks and how the user operates it.

## Section order

- Settings shows the sections in this order: **Providers**, **GitHub**, **Storage**, **Data display**.
- **Providers** is present in the desktop app and the browser.
- **GitHub** and **Storage** are always present.
- Each section is a feature composition of existing controls. It is not a new shared control or visual authority.

## Providers

### Layout

- The section composes the existing settings rows, the button roles, and the native Advanced disclosure.
- The order is Claude configuration, then its optional session override inside Advanced, then Codex home.
- The sole [Primary](../../../DESIGN.md#buttons) commitment is **Save and restart Pomegr**.
- Choosing, resetting, and discarding are Secondary or Quiet actions.
- Folder settings are independent of the header's display-preference reset.

### Desktop app

- The renderer shows only bounded source selection and folder availability.
- Native folder dialogs and confirmation dialogs display the paths.
- The privacy rules for these paths are in [Desktop and diagnostics](../architecture/privacy/desktop-and-diagnostics.md).

### Browser view

- The view shows the effective provider folder roots in read-only text fields.
- The view has no choose, default, discard, or save action.
- The fields support selection and copying.
- The view explains that changes require the desktop app.
- A missing root shows **Path unavailable**.
- A temporary read failure offers **Retry**.
- A denied browser read shows **Use paired LAN access to view provider folders.** and no retry action.
- A local browser and an authenticated, paired LAN browser may view these paths.
- This view replaces the temporary synthetic web preview.
- The access rule for the paths is in [Desktop and diagnostics](../architecture/privacy/desktop-and-diagnostics.md#provider-folder-read).

## Storage

### Layout

- The section is always present in desktop, browser, and paired LAN.
- Unlike Providers and Phone access, it is never conditionally hidden.
- The section reuses the settings-row geometry inside one bordered panel.
- The panel holds these four items in order:

| Item | Control |
| --- | --- |
| Retention age | Five-way `.commandSegmented` control: `30 days`, `90 days`, `180 days`, `365 days`, `Keep all` |
| Cleanup threshold | `CommandSelect` field: `250 MB`, `500 MB`, `1 GB`, `2 GB` |
| Usage | The storage usage meter (see below) |
| Status | Read-only storage-status line sourced from `GET /api/storage` |

### States

- Retention and threshold are desktop-only edits through the native storage-settings bridge.
- The monitor applies the edits on its next prune cycle.
- The browser and paired LAN views render the identical controls disabled.
- Those views show the monitor's current values.
- Those views show the existing `.providerSettingsGuidance` read-only note and no footer.
- The desktop footer reuses the `.providerSettingsFooter` roles **Discard changes** and **Save and restart Pomegr**.
- The desktop footer uses the same messaging as Providers.
- The storage data rules are in [Desktop and diagnostics](../architecture/privacy/desktop-and-diagnostics.md#storage-settings).

## Storage usage meter

### Layout

- `StorageUsageBar` (`.storageUsageBar`) is a small shared informational pattern.
- It has a numeric line in `--font-data`, reading `<used> / <threshold> · <pct>%`.
- It has a 6px `--command-panel-2` track (`.storageUsageTrack`).
- The fill is clamped to 0–100%.
- It has a muted explanatory line.

### Accessibility

- The track carries `role="meter"`.
- `aria-valuemin`, `aria-valuemax`, and `aria-valuenow` are all clamped to 100.
- `aria-valuetext` equals the numeric line.
- The meter is informational only, never focusable and never a slider.

### States

- A store over its threshold still prints its real percentage in text, for example `550 MB / 500 MB · 110%`.
- The fill clamps visually at 100%.
- When readiness is missing, `loading`, or `unavailable`, the meter reads **Storage usage unavailable**.
- The same applies when the byte or percent fields are `null`.
- The unavailable meter shows an empty track, no `role="meter"`, and no `aria-valuenow`.
- The meter never renders `0%` for missing evidence.
- A `role="status"` line beneath the meter names `cleanupStatus`.
- The line reads **Cleanup pending** or **Preserved history exceeds the cleanup threshold.**
- The ordinary state renders nothing.

## GitHub

### Layout

- The section reuses the Storage panel geometry.
- It is one bordered panel of `.commandSettingRow`s.
- The first row is the connection row.
- Only when connected, a **Repositories** row follows, then one row for each known repository.

### Connection row

- The row holds the **GitHub CLI** title and one fixed state line.
- The row holds a standard [`.commandChip`](../../../DESIGN.md#chips).
- The chip reads **Connected** with a green dot, **Not signed in** with an amber dot, or **Not installed**.
- The Secondary **Sign in with GitHub CLI** shows only when signed out.
- The Quiet **Check again** always shows.
- The sign-in opens the GitHub CLI's own sign-in in a terminal after a native confirmation.

### Repository rows

- Each row shows the display name in the data font.
- Each row shows a neutral **Private** or **Public** chip, and no chip when unknown.
- Each row shows fixed capability chips.

| Chip | Tone |
| --- | --- |
| **Can read issues** | positive |
| **Can create issues** | positive |
| **Issues are turned off** | warning |
| **No access** | neutral |

- A repository that could not be checked reads **Could not be checked.**

### States

- The section reads only in the desktop app.
- It reads once when opened and again on **Check again**.
- It reads at most the first 16 known repositories.
- It says so in a quiet line when more repositories exist.
- While reading, the section is busy: `aria-busy`, **Check again** disabled, and the previous rows kept.
- A browser or paired LAN client sees one desktop-only row and reads nothing.
- The section never shows a username, path, URL, or error text.

## About pane

- The About pane presents the painted mark beside the product name and purpose before operational metadata.
- Settings → About states that Pomegr is not affiliated with the providers.

## Samples

- `/design-system` renders every GitHub state from static data.
- `/design-system` renders the storage usage meter.
- `/design-system` renders the settings tab rail (`.commandSettingsNav`) with its pane.
