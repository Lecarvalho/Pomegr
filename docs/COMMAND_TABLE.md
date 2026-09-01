# Reusable command table

Use `CommandTable` from `app/components/command-center/CommandTable.tsx` for tabular UI. The Sessions and Dashboards views are its production examples.

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

The initial order is the caller's row order. The first click sorts descending; subsequent clicks toggle ascending/descending. Switching columns starts descending. Numeric values compare numerically, strings use locale-aware natural ordering, and dates should return numeric timestamps. Return a consistent value type within a column. Null, undefined, and non-finite numbers stay last in either direction; ties retain input order. The component never mutates caller rows.

Optional pagination accepts `{ page, pageSize, onPageChange, label }`, with a positive integer page size. Supply the entire filtered row set: sorting happens before pagination, and selecting a sort calls `onPageChange(1)`. The caller owns filter state and resets the page when filters change. The displayed page is clamped when rows shrink. Omit pagination to render every row.

Provide `emptyState` to customize the no-rows message. Keep the table mounted when filters match no rows so its sort choice survives. Updated rows are sorted using the current selection.

Column options `className` and `colClassName` style cells/headers and column widths. `hideLabel` visually hides an action header while preserving its accessible name; `sortLabel` clarifies the sort tooltip; `cellLabel` supplies a data label for a caller's responsive layout. The table's `className` scopes a custom layout. Shared styling provides a horizontally scrollable table; the eight-column mobile card layout belongs only to `commandSessionTable`.
