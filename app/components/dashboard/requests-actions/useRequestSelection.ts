import { useState } from "react";
import { windowFor, type RequestRow } from "./model";

type Selection = { rows: RequestRow[]; scope: string; size: number; selectedId: string | null; start: number; pinned: boolean };

function newest(rows: RequestRow[], scope: string, size: number): Selection {
  return { rows, scope, size, selectedId: rows.at(-1)?.id ?? null, start: windowFor(rows, rows.length, size).start, pinned: false };
}

function sameRows(left: RequestRow[], right: RequestRow[]) {
  return left.length === right.length && left.every((row, index) => row.id === right[index]?.id);
}

/** Keep retained evidence anchored by identity when the bounded feed rolls over. */
export function useRequestSelection(rows: RequestRow[], scope: string, size: number, historical: boolean, targetId: string | null = null) {
  const [stored, setStored] = useState(() => newest(rows, scope, size));
  // A fresh target also records reselecting the same bar after paging elsewhere.
  const [navigation, setNavigation] = useState<{ id: string } | null>(null);
  let current = stored;
  if ((!sameRows(stored.rows, rows)) || stored.scope !== scope || stored.size !== size) {
    const follow = !historical && !stored.pinned && stored.selectedId === stored.rows.at(-1)?.id && stored.start + stored.size - 1 >= stored.rows.length;
    if (stored.scope !== scope || !stored.rows.length || follow) current = newest(rows, scope, size);
    else {
      const selectedId = rows.find((row) => row.id === stored.selectedId)?.id ?? rows[Math.min(rows.length - 1, stored.rows.findIndex((row) => row.id === stored.selectedId))]?.id ?? null;
      const anchorId = stored.rows[stored.start - 1]?.id;
      const anchor = rows.findIndex((row) => row.id === anchorId);
      const start = stored.size !== size
        ? windowFor(rows, rows.find((row) => row.id === selectedId)?.ordinal ?? null, size).start
        : Math.max(1, Math.min(anchor >= 0 ? anchor + 1 : stored.start, Math.max(1, rows.length - size + 1)));
      current = { rows, scope, size, selectedId, start, pinned: stored.pinned };
    }
    setStored(current);
  }
  const target = targetId ? rows.find((row) => row.id === targetId) : null;
  if (target && current.selectedId !== target.id) {
    current = { ...current, selectedId: target.id, start: windowFor(rows, target.ordinal, size).start, pinned: true };
    setStored(current);
  }
  const selected = rows.find((row) => row.id === current.selectedId) ?? null;
  const end = Math.min(rows.length, current.start + size - 1);
  const select = (row: RequestRow, center = false) => {
    setNavigation({ id: row.id });
    setStored({ ...current, pinned: true, selectedId: row.id, start: center ? windowFor(rows, row.ordinal, size).start : current.start });
  };
  const moveWindow = (start: number) => setStored({ ...current, start: Math.max(1, Math.min(start, Math.max(1, rows.length - size + 1))) });
  const step = (delta: number) => {
    const ordinal = Math.max(1, Math.min(rows.length, (selected?.ordinal ?? rows.length) + delta));
    const row = rows[ordinal - 1];
    if (!row) return;
    setNavigation({ id: row.id });
    setStored({ ...current, pinned: true, selectedId: row.id, start: ordinal < current.start ? ordinal : ordinal > end ? Math.max(1, ordinal - size + 1) : current.start });
  };
  const selectScope = (nextRows: RequestRow[], nextScope: string, row: RequestRow) => {
    setNavigation({ id: row.id });
    setStored({ rows: nextRows, scope: nextScope, size, selectedId: row.id, start: windowFor(nextRows, row.ordinal, size).start, pinned: true });
  };
  return { selected, navigation, pinned: current.pinned, start: current.start, end, select, selectScope, moveWindow, step };
}
