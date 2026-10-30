# Settings design

> Scope: the Settings sections Providers, GitHub, Aril, Storage, and the storage usage meter, plus the About pane.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/settings/`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

This page states how each Settings section looks and how the user operates it.

## Section order

- Settings shows the sections in this order: **Providers**, **GitHub**, **Aril**, **Storage**, **Data display**.
- **Providers** is present in the desktop app and the browser.
- **GitHub**, **Aril**, and **Storage** are always present.
- `/settings?section=aril` opens **Aril**, and `&repository=<repository ID>` opens it for that repository. A value that is no repository ID is no choice.
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

## Phone access

- During recovery after a probe timeout, the panel says **Network verification timed out; retrying. Paired phones will reconnect automatically.**
- A timeout while starting sharing says **Network verification timed out. Retry phone access.**
- Recovery keeps **Stop sharing** available and hides pairing-code creation until verification succeeds.

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

## Aril

### Layout

- The section reuses the GitHub section's header: an `h2` **Aril** and one muted line, “Turn Aril on or off and say how you like to work. Grants and a repository's memory belong to one repository.”
- Under the header come the parts that belong to Aril itself, in this order: the [switch](#switch), [Your memory](#your-memory), and [Thread space](#thread-space).
- Then one bordered panel holds the **Repository** row (`SettingRow`).
- Under that panel, the body is the [Aril settings content](task-board.md#aril-settings-section) in a column of at most 560px, with no frame of its own.
- Its sections keep their `h3` headings: Grant, Actions under a grant, Limits, Work rules, Reviewer, Paired devices, Memory, and, in the desktop app only, Effort routing.
- The section is a feature composition of existing controls. It adds no shared control.

### Switch

- The first panel is bordered like the Repository panel (`.arilSettingsPanel`) and holds `SettingRow`s.
- Its first row is **Aril**. The description reads “Aril acts as you settled with it. Turning it off stops its actions at once; running sessions continue.” while On, and “Aril takes no action of its own. The chat still answers when you write.” while Off.
- The control is the state chip and the settings switch (`input role="switch"`, named **Aril**). The chip is **On** in the positive tone or **Off** in the neutral tone. Off is never amber: it is not a fault.
- The switch acts at once in either direction and asks for no confirmation. While a change is sent it is unavailable. A failed change keeps the state it had and shows the alert “Aril could not be changed. Try again.”
- The desktop app adds a second row, **Paired devices** (“Let a paired device turn Aril on. A paired device can always turn it off.”), with a switch named **Let a paired device turn Aril on**.
- A paired device has no second row. While Aril is Off and the desktop app has not allowed it, its switch is unavailable and a muted line says “Turning Aril on needs the desktop app.”
- Nothing is drawn for a state the desktop has not answered. The section says “Reading Aril…” as a status and never shows Off and then On.
- A browser that is neither the desktop app nor a paired device shows one muted line, “Turn Aril on or off in the desktop app or on a paired device.”, and no switch.
- While Aril is Off the Grant section says “Aril is off. A grant does nothing until you turn it on above.” and its **Start grant** is unavailable. An active grant says “Aril is off, so this grant does nothing until you turn it on above.” and keeps **Stop grant**.
- The state is also the chip beside Aril's name in the [panel header](agent-chat.md#header).

### Your memory

- A `taskGatesPanel` with the `h3` **Your memory**, in the body column. The desktop app and a paired device draw it; a browser does not.
- It is the shared memory list of the Memory section: the caption “How you like to work with Aril in every repository. Aril reads these lines and cannot change them; you edit them here.”, the “n of 100” counter, the lines oldest first, and the edit, delete, and add rows. Its fields are named **Add your entry** and **Edit your entry**.
- When the lines are more than Aril reads in a prompt (6,000 characters, the newest first), a muted line says “Aril reads the newest n lines. The m older lines do not fit its limit of 6,000 characters.” A repository's Memory shows the same line.
- A paired device reads the lines and has no field or action.
- The add and edit fields of both memories show no focus ring: the caret marks focus ([DESIGN.md](../../../DESIGN.md#agent-chat-exceptions)).
- A refused change keeps what was typed and shows the alert “Memory could not be saved. Try again.” While the lines are read, the section says “Reading your memory…” as a status.

### Thread space

- A `taskGatesPanel` with the `h3` **Thread space**, in the body column. Only the desktop app draws it; a paired device shows nothing and asks nothing.
- The caption reads “What each repository's conversation with Aril takes on disk. Flushing removes the oldest half of its messages and their images. Aril keeps its summary and the newest messages.”
- Each known repository with a thread has one row: its name in the data font, its size (bytes, KB, MB, or GB), and its number of messages, then the Quiet action **Flush oldest messages** (accessible name “Flush oldest messages of <repository>”). A repository with no thread is not listed, and a thread of one message has no action.
- The action asks in the row first: “Remove the oldest 20 of 40 messages and their images?” with a Secondary **Flush messages** and a Quiet **Cancel**. Cancel changes nothing.
- The result is one quiet status line, “Removed 20 messages and freed 700 KB.”. A repository where Aril is answering says “Aril is answering in this repository. Try again when it is done.”, and any other failure shows the alert “The messages could not be flushed. Try again.”
- While a flush runs, every flush action is unavailable. The sizes are read when the section opens and after each flush; nothing is drawn for them before they are read.

### Repository

- Aril's settings, memory, and grants belong to one repository, so the section holds a choice, as the chat does.
- The row's control is a `CommandSelect` named **Repository**, listing every known repository by its display name.
- With one repository, the control is its name in the data font.
- The section opens at the repository the link names, else the last one the owner chose in the chat or here, else the first listed.
- Choosing a repository is remembered in the browser's storage as the repository ID alone, under the key the chat uses.
- Changing the repository reads that repository's board. An unsaved draft is discarded, and the new draft starts from that repository's saved settings.
- With no repository, the section says “No repositories observed yet.” while a read says “Reading repositories…”.

### States

- While the board is read, the section says “Reading Aril settings…” as a status. A board that is not ready or holds no Aril settings says “Aril settings are unavailable.” and draws nothing else.
- In the desktop app the section edits. On a paired device it edits only when the saved **Allow paired devices to change Aril settings and memory** permits, and it can always stop an active grant.
- A browser with neither reads the saved values as text.
- The Effort routing section, its key field, and its state are drawn only by the desktop app. A paired device shows no heading, no state, and no field, and never asks the desktop whether a key is set.
- The Board keeps one quiet **Aril settings** link to this section for the board's repository, in its capacity strip.

## About pane

- The About pane presents the painted mark beside the product name and purpose before operational metadata.
- Settings → About states that Pomegr is not affiliated with the providers.

## Samples

- `/design-system` renders every GitHub state from static data.
- `/design-system` renders the Aril section's body from static data in each state listed in the [Task board design](task-board.md#aril-settings-section), and the switch, Your memory, and Thread space in every state above.
- `/design-system` renders the storage usage meter.
- `/design-system` renders the settings tab rail (`.commandSettingsNav`) with its pane.
