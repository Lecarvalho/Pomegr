# Feature management in the desktop app

> Status: proposed; prototype approved by the product owner on 2026-10-12 (task T-59), no code written.
> Created: 2026-10-12.
> Scope: let the owner create, edit, and delete a feature of a task board in the desktop app, with its title, description, and app version. Excludes the Queue view, which is to be removed, a separate Features list view, and any change to the agent feature tools.
> Prototype: [feature-management/prototype.html](feature-management/prototype.html). It links the app's own stylesheets, so open it from the repository. The rules below win where the drawing differs.
> Continuation owner: the sessions of board tasks T-70 (part 1) and T-71 (part 2).
> Authority: working proposal. [Tasks](../architecture/tasks.md), [task-modal.md](../design/task-modal.md), and [task-board.md](../design/task-board.md) stay authoritative; each part changes them.
> Next task or decision: T-70.
> Completion criteria: both parts merged, with `npm run build` and `npm test` passing, the design pages and `/design-system` holding the Feature modal, and the Tasks privacy section listing the new desktop read.
> Permanent destinations: [Tasks](../architecture/tasks.md) (actions, read, privacy), [task-modal.md](../design/task-modal.md) (the Feature modal), [task-board.md](../design/task-board.md) (the filter row), and `docs/public/using-pomegr/tasks.md` (user guide).
> Lifetime: temporary; part 2 deletes this page and `feature-management/` after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## Why

A feature has a title, a description, and an app version since task T-33. The desktop app
sets only the title, through an inline name form, and cannot rename or delete a feature.
Only an agent can write the other two fields.

## Decisions

The product owner took these on 2026-10-12.

| Subject | Decision |
| --- | --- |
| Surface | One Feature modal on the task modal's frame, in the modes New feature and Feature. |
| Fields | Title (required, 80 characters), Description (2,000), App version (40). |
| Entry point | The Board's filter row only: **+ New feature** opens the modal, and a Quiet **Edit feature** shows while one feature is chosen. |
| Queue view | Not changed. It is to be removed. |
| Features list view | Not built. The filter lists every feature, so a finished or an empty one is reached there. |
| Delete | Deleting a feature detaches its tasks. They stay on the board with no feature. |
| Delete refusal | Delete is refused while a task of the feature has started and is not done. |

The planner took these. A part may change one and must record it in its pull request.

| Subject | Decision |
| --- | --- |
| Task modal | Its inline **New feature…** name field stays, so a task form still makes a feature from a title alone. |
| Board read | `GET /api/tasks` keeps serving a feature as `{ id, name, done }`. |
| Details read | The desktop app reads one feature's description and app version when the modal opens. No browser or paired device receives them. |
| Agent tools | `create_feature`, `update_feature`, and `delete_feature` keep their rules. `delete_feature` still deletes only a feature with no task. |
| Detached tasks | A detached task keeps its column, position, state, queue state, and session, and loses its step. A queued one becomes a single task. |
| Client | Desktop app only, like every other board edit. |

## Parts

Each part is one board task, one session, and one pull request. The ACOS plan and its two
manifests are in [feature-management/acos/](feature-management/acos/plan.yaml).

| Part | Task | Makes true | Prototype sections |
| --- | --- | --- | --- |
| 1 | T-70 | The owner creates a feature with all three fields and edits them. | 1, 2, 3, 5 |
| 2 | T-71 | The owner deletes a feature. The part reviews the whole change and closes this plan. | 3, 4 |

- [ ] Part 1: create and edit.
- [ ] Part 2: delete, review, and plan closure.

## Privacy

A feature's description and app version are user-authored board content. Part 1 widens
their exposure by one path: the desktop app's own read. It changes
[Tasks: Privacy](../architecture/tasks.md#privacy) in the same pull request and verifies
that `/api/state`, `GET /api/tasks`, and every paired-device answer still hold neither
field.
