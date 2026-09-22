import { useState } from "react";
import { windowFor, type RequestRow } from "./model";
import { transferOnViewportMove } from "./selection-viewport";

type Selection = { rows: RequestRow[]; scope: string; size: number; selectedId: string | null; start: number; pinned: boolean };

function newest(rows: RequestRow[], scope: string, size: number, pinned = false): Selection {
  return { rows, scope, size, selectedId: rows.at(-1)?.id ?? null, start: windowFor(rows, rows.length, size).start, pinned };
}

function sameRows(left: RequestRow[], right: RequestRow[]) {
  return left.length === right.length && left.every((row, index) => row.id === right[index]?.id);
}

/**
 * Keep retained evidence anchored by identity when the bounded feed rolls over.
 * Selecting the newest request on the latest live page resumes following,
 * regardless of whether selection came from a bar, a row link, or a step.
 */
export function useRequestSelection(
  rows: RequestRow[],
  scope: string,
  size: number,
  historical: boolean,
  atLatest = true,
) {
  const [stored, setStored] = useState(() => newest(rows, scope, size, historical || !atLatest));
  // A fresh target also records reselecting the same bar after paging elsewhere.
  const [navigation, setNavigation] = useState<{ id: string; followLatest: boolean } | null>(null);
  let current = stored;
  if ((!sameRows(stored.rows, rows)) || stored.scope !== scope || stored.size !== size) {
    const follow = atLatest && !historical && !stored.pinned && stored.selectedId === stored.rows.at(-1)?.id && stored.start + stored.size - 1 >= stored.rows.length;
    // A selection absent from the new rows is never clamped to a false position: it rejoins the
    // newest request instead. History navigation supplies explicit transfer targets separately.
    const retainedId = rows.find((row) => row.id === stored.selectedId)?.id ?? null;
    if (stored.scope !== scope || !stored.rows.length || follow || retainedId === null) current = newest(rows, scope, size, historical || !atLatest);
    else {
      const selectedId = retainedId;
      const anchorId = stored.rows[stored.start - 1]?.id;
      const anchor = rows.findIndex((row) => row.id === anchorId);
      const start = stored.size !== size
        ? windowFor(rows, rows.find((row) => row.id === selectedId)?.ordinal ?? null, size).start
        : Math.max(1, Math.min(anchor >= 0 ? anchor + 1 : stored.start, Math.max(1, rows.length - size + 1)));
      current = { rows, scope, size, selectedId, start, pinned: stored.pinned || historical || !atLatest };
    }
    setStored(current);
  }
  const selected = rows.find((row) => row.id === current.selectedId) ?? null;
  const end = Math.min(rows.length, current.start + size - 1);
  /** `pin` keeps a newest selection from following later appends (for example a located deep link). */
  const select = (row: RequestRow, center = false, pin = false) => {
    const followsLatest = !pin && !historical && atLatest && row.id === rows.at(-1)?.id;
    setNavigation({ id: row.id, followLatest: followsLatest });
    setStored({ ...current, pinned: !followsLatest, selectedId: row.id, start: center ? windowFor(rows, row.ordinal, size).start : current.start });
  };
  /** Moving the window away from the selection transfers it to the nearest visible bar. */
  const moveWindow = (start: number) => {
    const nextStart = Math.max(1, Math.min(start, Math.max(1, rows.length - size + 1)));
    const target = selected ? rows[transferOnViewportMove({ selectedIndex: selected.ordinal - 1, offset: nextStart - 1, size })] : null;
    if (!selected || !target || target.id === selected.id) return setStored({ ...current, start: nextStart });
    const followsLatest = !historical && atLatest && target.id === rows.at(-1)?.id;
    setNavigation({ id: target.id, followLatest: followsLatest });
    setStored({ ...current, start: nextStart, selectedId: target.id, pinned: !followsLatest });
  };
  const step = (delta: number) => {
    const ordinal = Math.max(1, Math.min(rows.length, (selected?.ordinal ?? rows.length) + delta));
    const row = rows[ordinal - 1];
    if (!row) return;
    const followsLatest = !historical && atLatest && row.id === rows.at(-1)?.id;
    setNavigation({ id: row.id, followLatest: followsLatest });
    setStored({ ...current, pinned: !followsLatest, selectedId: row.id, start: ordinal < current.start ? ordinal : ordinal > end ? Math.max(1, ordinal - size + 1) : current.start });
  };
  const selectScope = (nextRows: RequestRow[], nextScope: string, row: RequestRow) => {
    const followsLatest = !historical && atLatest && row.id === nextRows.at(-1)?.id;
    setNavigation({ id: row.id, followLatest: followsLatest });
    setStored({ rows: nextRows, scope: nextScope, size, selectedId: row.id, start: windowFor(nextRows, row.ordinal, size).start, pinned: !followsLatest });
  };
  return { selected, navigation, pinned: current.pinned, start: current.start, end, select, selectScope, moveWindow, step };
}
