"use client";

import { useMemo, useState, type Key, type ReactNode } from "react";

type SortDirection = "ascending" | "descending";
type SortValue = string | number | null | undefined;

export type CommandTableColumn<Row> = {
  id: string;
  label: string;
  renderCell: (row: Row) => ReactNode;
  /** Omit to keep this column unsortable. Dates should return a timestamp. */
  sortValue?: (row: Row) => SortValue;
  sortLabel?: string;
  hideLabel?: boolean;
  className?: string;
  colClassName?: string;
  cellLabel?: string;
};

/** One labeled section of rows. The caller owns order and collapse: pass no rows for a collapsed group. */
export type CommandTableRowGroup<Row> = {
  key: Key;
  /** Rendered in a full-width row-group header cell above the group's rows. */
  header: ReactNode;
  rows: readonly Row[];
  /** Optional full-width row after the group's rows, such as a "Show all" link. */
  footer?: ReactNode;
};

type CommandTableProps<Row> = {
  caption: string;
  rows: readonly Row[];
  columns: readonly CommandTableColumn<Row>[];
  getRowKey: (row: Row) => Key;
  className?: string;
  emptyState?: ReactNode;
  /** Renders these sections in the caller's order instead of `rows`; sorting and pagination do not apply. */
  rowGroups?: readonly CommandTableRowGroup<Row>[];
  /** Pass a positive pageSize; the caller resets page when its filters change. */
  pagination?: { page: number; pageSize: number; onPageChange: (page: number) => void; label?: string };
};

function availableValue(value: SortValue) {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}

/** Sorts before optional pagination; ties retain input order. See docs/internal/development/command-table.md. */
export function CommandTable<Row>({ caption, rows, columns, getRowKey, className = "", emptyState = <p className="commandUnavailableNote">No rows to display.</p>, pagination, rowGroups }: CommandTableProps<Row>) {
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection } | null>(null);
  const sortColumn = columns.find((column) => column.id === sort?.columnId && column.sortValue);
  const orderedRows = useMemo(() => {
    const valueFor = sortColumn?.sortValue;
    if (!sort || !valueFor) return rows;
    return [...rows].sort((left, right) => {
      const a = availableValue(valueFor(left));
      const b = availableValue(valueFor(right));
      // Missing values stay last, independently of the selected direction.
      if (a == null) return b == null ? 0 : 1;
      if (b == null) return -1;
      const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
      return sort.direction === "ascending" ? comparison : -comparison;
    });
  }, [rows, sort, sortColumn]);
  const pageSize = pagination?.pageSize ?? Math.max(1, rows.length);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.max(1, Math.min(pagination?.page ?? 1, pageCount));
  const firstVisibleIndex = (activePage - 1) * pageSize;
  const visibleRows = orderedRows.slice(firstVisibleIndex, firstVisibleIndex + pageSize);
  const updateSort = (columnId: string) => {
    setSort((current) => ({ columnId, direction: current?.columnId === columnId && current.direction === "descending" ? "ascending" : "descending" }));
    pagination?.onPageChange(1);
  };

  // Keep sorting state while the caller's filters temporarily return no rows.
  if (rowGroups ? !rowGroups.length : !rows.length) return emptyState;
  const renderRow = (row: Row) => <tr key={getRowKey(row)}>{columns.map((column) => <td key={column.id} className={column.className} data-label={column.cellLabel}>{column.renderCell(row)}</td>)}</tr>;

  return <>
    <div className="commandTableWrap">
      <table className={["commandTable", className].filter(Boolean).join(" ")}>
        <caption className="commandVisuallyHidden">{caption}</caption>
        <colgroup>{columns.map((column) => <col key={column.id} className={column.colClassName} />)}</colgroup>
        <thead><tr>{columns.map((column) => {
          const direction = sortColumn?.id === column.id ? sort?.direction : undefined;
          return <th key={column.id} scope="col" className={[column.sortValue && "commandTableSortable", column.className].filter(Boolean).join(" ")} aria-sort={direction}>
            {column.sortValue ? <button type="button" className="commandTableSort" onClick={() => updateSort(column.id)} title={"Sort by " + (column.sortLabel ?? column.label.toLowerCase()) + " (" + (direction === "descending" ? "ascending" : "descending") + ")"}>
              <span className={column.hideLabel ? "commandVisuallyHidden" : undefined}>{column.label}</span>
              <svg className="commandTableSortIcon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {!direction ? <path d="m5 6 3-3 3 3M5 10l3 3 3-3" /> : direction === "ascending" ? <path d="M8 13V3m-4 4 4-4 4 4" /> : <path d="M8 3v10m-4-4 4 4 4-4" />}
              </svg>
            </button> : <span className={column.hideLabel ? "commandVisuallyHidden" : undefined}>{column.label}</span>}
          </th>;
        })}</tr></thead>
        {rowGroups ? rowGroups.map((group) => <tbody key={group.key}>
          <tr className="commandTableGroupRow"><th scope="rowgroup" colSpan={columns.length}>{group.header}</th></tr>
          {group.rows.map(renderRow)}
          {group.footer && <tr className="commandTableGroupFooter"><td colSpan={columns.length}>{group.footer}</td></tr>}
        </tbody>) : <tbody>{visibleRows.map(renderRow)}</tbody>}
      </table>
    </div>
    {pagination && !rowGroups && pageCount > 1 && <nav className="commandPagination" aria-label={pagination.label ?? caption + " pages"}>
      <span className="commandPaginationSummary">Showing {firstVisibleIndex + 1}–{Math.min(firstVisibleIndex + pageSize, rows.length)} of {rows.length}</span>
      <div className="commandPaginationControls">
        <button className="commandSecondaryAction" type="button" onClick={() => pagination.onPageChange(activePage - 1)} disabled={activePage === 1}>Previous</button>
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => <button type="button" className="commandSecondaryAction commandPaginationPage" aria-label={"Go to page " + pageNumber} aria-current={pageNumber === activePage ? "page" : undefined} onClick={() => pagination.onPageChange(pageNumber)} key={pageNumber}>{pageNumber}</button>)}
        <button className="commandSecondaryAction" type="button" onClick={() => pagination.onPageChange(activePage + 1)} disabled={activePage === pageCount}>Next</button>
      </div>
      <span className="commandPaginationPageStatus" aria-live="polite">Page {activePage} of {pageCount}</span>
    </nav>}
  </>;
}
