# Settings design

> Scope: the Settings sections Providers, GitHub, Aril, Storage, and the storage usage meter, plus the About pane and the phone layout of the Settings page.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/settings/`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

This page states how each Settings section looks and how the user operates it.

## Section order

- Settings shows the sections in this order: **Providers**, **GitHub**, **Aril**, **Storage**, **Data display**.
- **Providers** is present in the desktop app and the browser.
- **GitHub**, **Aril**, and **Storage** are always present.
- `/settings?section=aril` opens **Aril**, and `&repository=<repository ID>` opens the memory at that repository's tab. A value that is no repository ID is no choice.
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

The owner approved the mockup `ArilSettings.dc.html` on 2026-10-30. The section is cards of one column, at most 820px wide, 20px apart. A card is a one-pixel `--command-line` panel with the 6px panel radius.

### Layout

- The section has no header of its own. The `h2` **Aril** is the heading of the top card, so it is the only Aril on the page.
- The cards come in this order: the top card, a line for each grant that is still running, the notice that appears only while Aril is off, then **Memory**, **Conversation space**, and **Effort routing** (desktop app only) in one wrapper. There is no per-repository settings card: the reviewer choice moves to an agreement's Review action in phase 5 of the [Aril plan](../plans/aril-agent.md), and the one paired-device permission is in the top card.
- A card head holds an `h3` in the section type step (650, 16px) and at most one control on the right. A card body is 24px from its edges (16px on a phone).
- Muted captions use the metadata step in `--command-muted`.
- The section is a feature composition of existing controls and the shared [switch](../../../DESIGN.md#switch). It adds no other shared control.

### Top card

- It holds a 48px mark, the heading **Aril** with the state word, one state line, and the shared switch, centered vertically on the right.
- The mark is a rounded square with the 6px panel radius, with the Aril glyph in `currentColor`.
- While On, the state word and the mark are green, the mark sits on `--color-green-soft`, and a soft glow fills the card: a one-pixel inner line of `--command-green` at 33% and a radial gradient of `--color-green-soft`. The glow fades in over 400ms and the mark recolors over 300ms. Reduced motion removes both.
- While Off, the state word and the mark are neutral. Off is never amber: it is not a fault.
- The On line reads “Keeping work moving as you settled it. Turn off to stop every action at once; running sessions keep going.” The Off line reads “Aril is off: no chat and no actions. Turn it on to talk to Aril or change anything below.”
- Pomegr ships with Aril On: a fresh install reads On, and the card never shows Off before the owner has turned it off (or a damaged switch file has made it read Off).
- Off means no Aril at all, so the chat is not drawn anywhere while the card reads Off ([Agent chat design](agent-chat.md#while-aril-is-off), [Home design](home.md#while-aril-is-off)). The switch card, the page below it, and its gray read-only state are the only parts of Aril the owner still sees.
- The switch is named **Let Aril act**, acts at once in either direction, and asks for no confirmation. Turning it off grays the cards under it (see [While Aril is off](#while-aril-is-off)). While a change is sent it is unavailable. A failed change keeps the state it had and shows the alert “Aril could not be changed. Try again.” in a row under the card.
- Nothing of the state is drawn until the desktop has answered: the card shows the heading and “Reading Aril…” as a status, with no word, no glow, and no switch. It never shows Off and then On.
- The desktop app adds one row under the card, divided by a one-pixel rule: “A paired phone can always turn Aril off. Let it also turn Aril on and change Aril's repository memory and settings.”, with the small switch on the right, aligned to the main switch. It is the only paired-device permission on the page, for every repository, and it is off until the owner turns it on.
- The row says repository memory, not memory: the owner's own memory is edited in the desktop app only, and a phone reads it whatever the row allows.
- A paired device has no such row. While Aril is Off and the desktop app has not allowed it, its switch is unavailable and the row says “Turning Aril on needs the desktop app.”
- A browser that is neither the desktop app nor a paired device shows the heading and one muted line, “Turn Aril on or off in the desktop app or on a paired device.”, and no switch.
- The state is also the chip beside Aril's name in the [panel header](agent-chat.md#header), which reads On whenever the panel exists.

### While Aril is off

- With Aril off, everything under the top card is read only and gray: both memory tabs, the conversation space (the limit and every flush), and the effort routing.
- The top card and its paired-device row stay active, so Aril can be turned on again. The line of a running grant stays active too, because a grant can always be stopped.
- The cards sit in one wrapper, `.arilBelow.isLocked`, with `opacity: 0.55`, `filter: grayscale(1)`, `pointer-events: none`, and `aria-disabled="true"`. Opacity and filter change over 260ms; reduced motion removes the motion.
- Every real control under the wrapper is also `disabled`, so the keyboard and a screen reader meet the same state: the tabs, the memory field and **Show change**, the limit select, **Flush oldest**, and **Replace key** and **Remove**.
- A neutral notice sits between the top card and the wrapper: a 14px lock, then “Aril is off, so everything below is read only. Turn Aril on to change it.” It has the raised `--command-panel-2` fill, the 6px panel radius, 10px by 14px padding, and application text. It is a status and never amber.
- Turning Aril off closes any open edit: a memory draft is dropped, a flush question closes, and the key field closes and empties. Nothing is saved on the way.
- Until the desktop has answered the switch, the cards read as gray with no notice, so the page never shows them editable and then takes that back. A plain browser has no switch and its cards are never gray.
- Desktop main refuses the same writes while Aril is off, including a change to Aril's settings ([Agent chat: The switch](../architecture/agent-chat.md#the-switch)), so the page and the app agree even when Aril is turned off on another device.

### Running grant

- Phase 5 of the Aril plan replaces grants with agreements, so the section no longer has a grant's sections. A grant that is still running keeps one line, in a panel of its own under the top card: “A grant in <repository> is active until HH:MM.” with the time in the data font.
- With Aril Off the line adds “Aril is off, so it does nothing.”
- **Stop grant** is a Secondary action named “Stop grant in <repository>”. It needs no confirmation. A paired device can always stop a grant; a browser reads the line with no button. A failed stop shows “The grant could not be stopped. Try again.” as an alert.
- A grant that has ended, or none, draws no line.

### Memory

- One card with the `h3` **Memory**, drawn by the desktop app, a paired device, and a browser that can read a repository's board. A plain browser has no **You** tab.
- The head holds a tab list in a ground-colored frame: **You** first, then one tab for each known repository by its display name. The tab list scrolls sideways when the tabs do not fit, and is not drawn when there is only one tab. Arrow keys, Home, and End move between tabs.
- A selected tab has the `--command-panel-2` fill and application text; the others are muted. The memory opens on **You**, or on the repository a link names.
- The **You** caption reads “How you like things done, in every repository. Context for Aril, not permission: it lets Aril do nothing new. Aril keeps it current; edit anything.” A repository's caption reads “How things are done in <repository>. Context for Aril, not permission. Aril keeps it current; edit anything.” Both say that memory is context and not an agreement.
- The body is one free-text field in the data font on the ground fill, with the 4px control radius, no border, at least 188px tall, and resizable vertically. It stops at 6,000 characters.
- The field shows no focus ring: the caret marks focus ([DESIGN.md](../../../DESIGN.md#agent-chat-exceptions)).
- The field saves when the owner leaves it. While the text differs the footer says “Saves when you leave the field”, and while it is sent “Saving…”. A refused save keeps what was typed and shows the alert “Memory could not be saved. Try again.”
- The footer holds a 6px coral dot, a sentence, **Show change**, and the live count “n / 6,000” in the data font. The sentence says who changed the memory last and when: “You edited this 3 days ago”, “Aril added a line 2 h ago”, “Aril removed 2 lines yesterday”, “Aril updated this just now”, or “Nothing saved yet”. Times read “just now”, “n min ago”, “n h ago”, “yesterday”, and “n days ago”.
- **Show change** is a Quiet action, drawn only when there is a text before the last change. It opens two columns, **Before** and **Now**, in the field's type; a line the other side does not have carries a coral bar. **Hide change** closes it. There is no undo.
- Only the desktop app edits the owner's memory. A paired device reads it. A repository's memory is edited in the desktop app, and on a paired device only while the top card's paired-device permission is on, for every repository. A field that cannot be edited is read-only with the same look.
- Until the memory is read, the card says “Reading memory…” as a status. A board that holds no Aril data says “Memory is unavailable.”

### Conversation space

- One card with the `h3` **Conversation space**, drawn only by the desktop app; a paired device shows nothing and asks nothing. The sizes are read when the section opens and after each flush; nothing is drawn for them before they are read.
- The head holds **Flush oldest at**, a `CommandSelect` with **2 MB**, **5 MB**, **10 MB**, **25 MB**, and **Never**, 5 MB by default. A failed change shows the alert “The limit could not be changed. Try again.”
- The caption reads “<total> in all. At 5 MB, Aril removes a conversation's oldest messages and their images, down to 75% of that. Its summary and newest message stay.” With Never it reads “<total> in all. Nothing is removed unless you flush it.”
- Each known repository with a thread has one row, largest first: its name in the data font, a bar, its size and message count, and a Quiet action. A repository with no thread is not listed.
- The bar is an 8px track on `--command-panel-2` with the control radius, a fill, and a 2px tick of `--command-line-strong` at the limit. It carries `role="meter"` named “<repository> conversation size”, with a text such as “4.3 MB of 5 MB”.
- The fill is `--command-muted` and turns brand coral, `--command-brand-text`, at 80% of the limit or more. It is never amber. It grows over 520ms; reduced motion removes the motion.
- With Never the bars are scaled to the largest thread plus a quarter and have no tick.
- The size reads “1.9 MB” and the count “· 401 messages” in muted text. The action is **Flush oldest** (accessible name “Flush oldest messages of <repository>”), or an unavailable **Nothing to flush** for a thread of one message.
- The flush asks under the row first: “Remove the oldest 200 of 401 messages and their images?” with a Secondary **Flush messages** and a Quiet **Cancel**. Cancel changes nothing.
- The result is one quiet status line under the row, “Removed 20 messages and freed 700 KB.” A repository where Aril is answering says “Aril is answering in this repository. Try again when it is done.”, and any other failure shows the alert “The messages could not be flushed. Try again.” While a flush runs, every flush action is unavailable.
- On a phone the row stacks: the name with **Flush oldest** on the first line, then a full-width bar, then the size.

### Effort routing

- One compact row in its own card. The desktop app draws the whole row. A paired device draws only the title, the caption, and the line “The key is changed in the desktop app.”: it shows no state and no field, and it never asks the desktop whether a key is set, so a phone never learns whether one is.
- A browser that is neither the desktop app nor a paired device draws nothing of it.
- It holds the `h3` **Effort routing**, the status beside it, the caption “Jev may lower the effort you chose for simple replies, never raise it. It sees your message and the end of Aril's last answer.”, a Secondary **Replace key** (**Add key** without a key), and a Quiet **Remove** (accessible name “Remove Jev key”) while a key is set.
- The status reads “Jev key set” in green, “No Jev key”, “Checking…” while it is read, or “This computer cannot store the key safely” with no button.
- **Replace key** opens one row under the card: a masked field named **Jev key** (at most 512 characters, autofill off), a Secondary **Save key**, and a Quiet **Cancel**. **Save key** is unavailable until the field holds 8 to 512 characters without spaces; a shorter or spaced key shows “Use 8 to 512 characters without spaces.”
- **Remove** acts at once. A saved key empties the field and closes the row. The page never shows the key, only that one is set.
- A failed action keeps what was typed and shows “The key could not be saved. Try again.” or “The key could not be removed. Try again.” as an alert.

### What the section keeps from the grant era

- The card **Per repository** is gone, with its repository choice. The memory has one tab for each repository, and nothing else on the page is about one repository.
- The card held **Reviewer**, **Different provider than the builder**, and **Paired devices**. Each has no control now.
- The reviewer settings serve only grant reviews, and grants are being decommissioned. Phase 5 of the [Aril plan](../plans/aril-agent.md) puts the reviewer choice on the Review action of an agreement.
- The stored reviewer values stay as they were, and the grant runtime reads them as before.
- The top card's one permission replaces **Paired devices**, for every repository. The stored per-repository values stay unused, except for the one-time carry-over in [Agent chat: The switch](../architecture/agent-chat.md#the-switch).
- **Follow-ups**, the limits, the work rules, and the grant actions have no control. Their stored values stay, and the grant runtime reads them as before.

## Settings on a phone

The owner approved the phone layout of Settings › Aril (`ArilSettingsPhone.dc.html`) on 2026-10-30. It holds in the paired-device view, which a phone gets through the LAN gateway, and in the desktop app at the same width.

- At 760px and narrower the Settings layout is one column whose track is `minmax(0, 1fr)`. A bare `1fr` grows to the full width of the section tabs, and the whole page scrolls sideways.
- The page never scrolls sideways. Nothing is wider than the screen at 390px.
- The section tabs scroll sideways inside their own strip, and each tab is at least 44px high.
- The pane has 16px of padding, and every card is as wide as the pane.
- Every control reaches 44px on a phone and on a coarse pointer: the tabs, the memory tabs, **Flush oldest**, the flush buttons, the limit select, **Replace key**, **Remove**, the key field, and **Stop grant**. The switches keep their size and reach 44px through their hit area.
- The small switch of the paired-device row has a hit area of 44px as well.

## About pane

- The About pane presents the painted mark beside the product name and purpose before operational metadata.
- Settings → About states that Pomegr is not affiliated with the providers.

## Samples

- `/design-system` renders every GitHub state from static data.
- `/design-system` renders the shared switch, every state of the top card, the memory (yours, a repository's, with the change shown, read-only, a failed save, and reading), the conversation space (with a limit, with Never, a flush question, flushed, and not flushed), the effort routing (key set, no key, the key field, and a paired device), and the running-grant line. It has no sample of a per-repository card.
- `/design-system` renders the storage usage meter.
- `/design-system` renders the settings tab rail (`.commandSettingsNav`) with its pane.
