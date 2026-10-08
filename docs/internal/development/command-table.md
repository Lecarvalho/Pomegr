# Reusable command table

> Scope: how to integrate `CommandTable` in a new tabular view.
> Authority: component integration guidance. Visual design belongs to [DESIGN.md](../../../DESIGN.md) and the `/design-system` page ([`app/components/design-system/`](../../../app/components/design-system/), served by `app/design-system/page.tsx` on the web dev server); this page does not restate colors, spacing, type sizes, or control styles.
> Related code and checks: `app/components/command-center/CommandTable.tsx`; `npx vitest run tests/ui/command-table.test.tsx`.

Use `CommandTable` from `app/components/command-center/CommandTable.tsx` for tabular UI. The Sessions directory (`CommandViews.tsx`) and the Agents roster (`AgentsRosterPanel.tsx`) are its production callers. Both keep the caller's row order today; sorting and pagination are covered by `tests/ui/command-table.test.tsx`.

## Columns and sorting

Define typed columns with stable IDs, labels, and cell renderers. Sorting is opt-in: add `sortValue` to a column to give its header a keyboard-accessible sort button. Omit it for a plain header.

```tsx
import { CommandTable, type CommandTableColumn } from "./CommandTable";

type Item = { id: string; name: string; count: number | null };
const columns: CommandTableColumn<Item>[] = [
  { id: "name", label: "Name", renderCell: (item) => item.name },
  {
    id: "count", label: "Count",
    renderCell: (item) => item.count ?? "—",
    sortValue: (item) => item.count,
  },
];

<CommandTable
  caption="Observed items"
  rows={items}
  columns={columns}
  getRowKey={(item) => item.id}
/>
```

The initial order is the caller's row order. The first click sorts descending; subsequent clicks toggle ascending/descending. Switching columns starts descending. Numeric values compare numerically, strings use locale-aware natural ordering, and dates should return numeric timestamps. Return a consistent value type within a column. Null, undefined, and non-finite numbers stay last in either direction; ties retain input order. The component never mutates caller rows. A sortable header exposes its direction through `aria-sort`, and `caption` names the table for assistive technology without being shown.

## Pagination and empty states

Optional pagination accepts `{ page, pageSize, onPageChange, label }`, with a positive integer page size. Supply the entire filtered row set: sorting happens before pagination, and selecting a sort calls `onPageChange(1)`. The caller owns filter state and resets the page when filters change. The displayed page is clamped when rows shrink. Omit pagination to render every row; the paging controls appear only when there is more than one page.

Provide `emptyState` to customize the no-rows message. Keep the table mounted when filters match no rows so its sort choice survives. Updated rows are sorted using the current selection.

## Row groups

Pass `rowGroups` to render labeled sections instead of `rows`: each `{ key, header, rows, footer? }` becomes its own `<tbody>` with a full-width `scope="rowgroup"` header cell, the group's rows, and an optional full-width footer row. Groups and their rows keep the caller's order; sorting and built-in pagination do not apply, and an empty `rowGroups` renders `emptyState`. The caller owns collapse: pass no rows for a collapsed group and put the toggle in `header`. The Sessions directory uses this for its Recent, Repository, and Provider groupings.

## Column and layout options

Column options `className` and `colClassName` attach caller classes to cells/headers and to column widths. `hideLabel` visually hides an action header while preserving its accessible name; `sortLabel` clarifies the sort tooltip; `cellLabel` supplies a `data-label` for a caller's responsive layout. The table's `className` scopes a custom layout.

The default table scrolls horizontally when it is wider than its container. The eight-column phone card layout is specific to `commandSessionTable` in `app/styles/workspace.css`, which depends on that table's column order; another table that needs a phone layout defines its own scoped class.

## Visual authority

Follow [DESIGN.md](../../../DESIGN.md) for table, row, and control styling, and use only its documented tokens and control roles when adding caller classes. `/design-system` renders a `CommandTable` sample with a sortable header, a pagination footer, row groups, and both empty-state forms. The sort states (unsorted, descending, ascending) can only be clicked through on that page, not rendered statically side by side (see DSG-7 in the [design system gaps plan](../plans/design-system-gaps.md)). Neither production caller enables sorting or built-in pagination, so those states are also covered in `tests/ui/command-table.test.tsx`. A caller that adds a new table state adds its sample to `/design-system`, with `DESIGN.md` and its contract test, instead of documenting the styling here.
