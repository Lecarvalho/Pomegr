# Repositories design

> Scope: the Repositories index, the repository detail and its tabs, `RepositoryRow`, `FileTree`, `FileHistoryPanel`, and `SessionFilePanel`.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/repositories/`, `app/components/dashboard/SessionFilePanel.tsx`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

This page covers how the repository surfaces look and how the user operates them.

## Repositories index

### Layout

- The index is a flat, linked list of observed projects.
- Each row shows the repository name, observed provider badges, live and history session counts, last activity, and one bounded Pomegr setup summary.
- The toolbar combines repository search with the All, Needs attention, and Live now filters.
- On phone, the rows reflow into a compact layout.
- On phone, search and filters keep targets of at least 44px.

### Accessibility

- Row links name the repository and the setup state.

## Repository detail

### Layout

- Repository detail is a linked `/repositories/<repositoryId>` route.
- The header uses the shared breadcrumb as its only repository name.
- After the breadcrumb, the header shows the live and history counts, the observed provider badges, and the [Secondary](../../../DESIGN.md#buttons) button **View sessions**.
- The header does not repeat the repository name as a page title.
- The header shows no repository icon.
- The shell uses the shared session breadcrumb for `Repositories › {displayName}`.
- The breadcrumb marks the current page.
- Detail navigation uses the existing Settings layout.
- On desktop, the navigation is a 210px rail with seven tabs: Overview, Files, Git, Tasks, Plugin, Context inventory, Reporting.
- On phone, the navigation is the horizontal strip of the Settings layout.
- The active tab is backed by `?tab=` in the URL.
- Legacy repository query links redirect to the Context inventory tab.

### Keyboard and focus

- Tabs support the arrow keys and Home/End.
- A pane change restores focus to the selected tab.
- Native action completion also restores tab focus, unless the user has moved to another control.

### Tabs

| Tab | Content |
| --- | --- |
| Overview | Snapshot facts, linked setup summaries, and the five most recent associated sessions |
| Files | `FileTree` and `FileHistoryPanel` |
| Git | The shared neutral chip with an 8px gap before its placeholder title |
| Tasks | One short pane: a heading, one sentence, and the Secondary **Open task board** link to `/tasks?repository=<repositoryId>` |
| Plugin | Plugin installation instructions and native actions, grouped by provider |
| Context inventory | One section per provider, described below |
| Reporting | The shared policy state with always-visible setup guidance |

- The Tasks tab only links to the Tasks page.
- The board is specified in [Task board design](task-board.md).

### Setup mutations

- Setup mutations require native confirmation.
- Browser clients receive setup instructions.

## RepositoryRow

### Layout

- Repository detail setup rows use `RepositoryRow` with `.commandSettingRow.repositoryRow`.
- The row keeps the existing settings grid and divider spacing.
- The row shows a 13px/600 title beside a standard `.commandChip`.
- The row shows a muted 12px detail.
- The actions sit on the right.
- Versions and checked times use the data font.
- Each independent row has at most one primary commitment: Install plugin, Update plugin, or the Run diagnostic of the inline confirmation.
- Repository-local classes compose the existing Settings geometry, `CommandSelect`, chips, and button roles through `RepositoryRow`.

### Phone

- Actions stack below the detail.
- Actions split the available width in equal-width columns with 44px targets.

## Context inventory

### Content

- The tab uses one section per provider.
- Codex has an explicit not-yet-available state.
- A revision select appears when multiple saved revisions exist.
- Each section shows four bounded evidence facts and a category grid.
- Listed items are expandable.
- The section offers revision comparison.
- The capture action and its inline confirmation reuse the existing button roles and the native confirmation boundary.
- Inventory capture times stay right-aligned.
- Provider check times are omitted.

### States

- The tab has explicit loading, unavailable, and sanitized failure states.

### Phone

- Capture confirmation buttons stack.

## FileTree

### Content

- `FileTree` (`app/components/repositories/FileTree.tsx`) is a shared, fetch-free presentation control.
- It sits behind the session Repository tab's Touched here / Uncommitted / Changed elsewhere tree.
- It also sits behind the repository Files tab.
- `FileHistoryPanel` (`FileHistoryPanel.tsx`) serves the repository Files tab.
- The session tab pairs the tree with `SessionFilePanel` instead.
- The session Repository tab's file toolbar ends with a neutral **Beta** `.commandChip` while file coverage is still in progress.
- The **Beta** chip has the `title` **File coverage is still being expanded.**
- The **Beta** chip is right-aligned on desktop.
- On phone, the **Beta** chip is left-aligned below the segments.

### Layout

- `FileTree` is a `panel` (1px border, 6px radius) in a column with overflow hidden.
- The header row has 8px/14px padding.
- The header row shows the repository name as a muted 11px uppercase eyebrow.
- In repository scope, the header row has a right eyebrow **Sessions**.
- Rows are 13px with 6px/14px padding.
- Rows indent 14/30/46/62px per depth.
- Folders sort first, then files, both alphabetical.
- Folder rows carry a 12px chevron: right when collapsed, down when expanded.
- Folder rows show a mono folder name.
- File rows carry no chevron.

### Keyboard and focus

- Rows are keyboard-reachable buttons.
- Enter and Space select a row.

### States

- Folders default to collapsed.
- The exception is ancestors of the current selection and top-level folders with 12 or fewer files total.
- `expandAll` (search active) opens every folder.
- The selected row alone takes the raised fill and ink text.
- Nothing else marks selection.

### Session scope

- Session scope shows a working-tree status letter, right-aligned at the end of the row, in editor style.
- The letter is `.fileTreeStatusLetter`: 11px semibold mono with no chip frame.
- The tone is in the text only.
- The full word is the letter's `title` and its accessible name.

- The letters are amber **M** (Modified), green **U** (Untracked) and **A** (Added), and neutral **D**/**R** (Deleted/Renamed).

| Letter | Meaning | Tone |
| --- | --- | --- |
| **M** | Modified | amber |
| **U** | Untracked | green |
| **A** | Added | green |
| **D** | Deleted | neutral |
| **R** | Renamed | neutral |

- The working tree may report no status, because the change is committed or reverted.
- Then a touched row falls back to this session's recorded kind as a neutral muted letter.
- The fallback letter is never amber, because nothing is pending.
- Deleted and moved kinds show no letter.

| Recorded kind | Letter | Name |
| --- | --- | --- |
| Created | **C** | **Created in this session** |
| Edited | **M** | **Edited in this session** |

- A Git-observed row without a recorded kind uses its Git net change in the same neutral way.

| Git net change | Letter | Name |
| --- | --- | --- |
| Added | **A** | **Added in a commit by this session** |
| Modified | **M** | **Modified in a commit by this session** |
| Deleted | **D** | **Deleted in a commit by this session** |

- After the tree, an eyebrow **Changed elsewhere** group lists flat uncommitted rows.
- Each **Changed elsewhere** row shows the full path, indent 14, and its own status letter.
- The **Changed elsewhere** group is hidden when empty.
- A touched row can be one that a Git command of the session committed but no tool ever recorded.
- That row carries a quiet 14px git glyph after the file name.
- The glyph uses muted text color, never amber.
- The glyph shows on historical rows too.
- The glyph has the `title` and the accessible name **Committed by this session - not a recorded tool edit**.
- Selecting the row still opens file history as usual.

### Repository scope

- Each file and folder shows its distinct-session count, right-aligned in muted 11px mono, from the monitor's rollup.
- A file with no recorded session history shows no count.
- That file renders muted.

### Footer

- A pinned footer rule reads **Status from the working tree · select a file for its history** in session scope.
- In repository scope, the footer reads **Folders roll up distinct sessions**.
- A quiet **How to read this** popover appears in the session footer only when a Git-observed row is visible.
- The popover text is: *Rows with the Git glyph come from commits made while this session ran a Git command. Matched by time, so they have no agent or request.*

## FileHistoryPanel

### Content

- `FileHistoryPanel` renders the committed session history of the selected file on the repository Files tab.
- It never fetches the history itself.
- The header holds a muted 11px mono breadcrumb (`<repository> / <dir>/`).
- Below the breadcrumb, a row holds a file glyph and the mono 14px bold file name.
- The row also holds a working-tree chip, only when the file currently has a working-tree status.
- The chip spells the status out.

| Status | Chip | Tone |
| --- | --- | --- |
| Modified | **Modified in working tree** | amber |
| Untracked | **Untracked in working tree** | green |
| Added | **Added in working tree** | green |

- The header has a right-aligned action **Copy path** (secondary action).
- **Copy path** copies the repository-relative path.
- **Copy path** shows a brief **Copied** state.
- A third row reads **N recorded sessions · newest first**.
- Beside it, a `.commandSegmented` provider filter appears only when more than one provider is present among the sessions.

### Entries

- Each entry leads with the session title in regular-weight ink.
- The title links to `/sessions/<id>?tab=repository&path=<path>`.
- The bold file name stays the heading of the panel.
- A single meta line below the title holds, in order, these parts.
- A kind chip, only for the rarer kinds.
- The provider chip.
- One muted text run that joins with ` · ` the edit count and the agent names.
- A green **live** chip for a live session.
- Edited is the common case and gets no chip.
- The panel has no per-agent role dots.
- A moved entry also shows a muted mono **as `<old path>`** line.

| Kind chip | Tone |
| --- | --- |
| **Created** | context (lavender) |
| **Deleted** | amber |
| **Moved** | neutral |

| Edit count text | When |
| --- | --- |
| **N edits** | The edit recorded a count |
| **Edited** | The edit recorded no count |

- The agent names show as **N agents** when the names are not individually known.

### States

- The panel shares one frame across its states.
- No file selected.
- A loading skeleton.
- **File history is rebuilding.**
- **File history is unavailable.**
- **No recorded sessions changed this file.**
- A muted **N changes without session attribution (moves seen in Git)** line shows whenever evidence includes changes with no session attribution.

### Footer

- The footer states the honest Write/Edit coverage caveat.
- A **How to read this** dotted info popover holds the longer Git-move and retention explanation.

## SessionFilePanel

### Content

- `SessionFilePanel` (`app/components/dashboard/SessionFilePanel.tsx`) is the right panel of the session Repository tab.
- It shows only what this session did to the selected file.
- It builds from the repository domain that the tab already holds, so selecting a file never waits on a fetch.
- The history of the file across sessions stays on the repository page.
- It shares the frame and header of `FileHistoryPanel`: breadcrumb, file name, and the working-tree chip or **at last live check** chip.
- The header action is **All history on repository page** (Quiet action, trailing chevron).
- The action links to `/repositories/<id>?tab=files&path=<path>`.

### Entry

- One entry follows the header.
- For a recorded change, the entry shows **Recorded in this session**, the kind chip, a muted **N changes** run, and the latest change time.
- The kind chip is always shown here: **Edited**, **Created**, **Deleted**, or **Moved**.
- For a file that only a session commit changed, the entry shows **Committed by this session · no recorded agent edit**.
- That entry then shows one of **Added in the commit**, **Modified in the commit**, **Deleted in the commit**, or **Net change not recorded**.
- That entry ends with a muted caption: **Matched by time to a Git command this session ran. Pomegr can't tell which agent changed the file.**
- The panel never names who changed the file.

### States

- **No recorded change in this session.**
- The loading skeleton, while recorded changes load.
- **Recorded changes are unavailable.**

## Samples

- `/design-system` renders `FileTree` and `SessionFilePanel` with static data.
- A session-scope tree with a Changed elsewhere group, a selected row, and a Git-observed row.
- A repository-scope tree with counts and a muted no-history file.
- A `FileHistoryPanel` sample for the repository side, plus the empty and loading state.
- `SessionFilePanel` samples for a recorded file and a Git-observed file.
- The design-system reference includes a static `RepositoryRow` sample.
