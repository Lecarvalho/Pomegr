"use client";

import type { RefObject } from "react";

/** What the first column needs to open the New task panel and to take focus back when it closes. */
export type NewTaskEntry = { triggerRef: RefObject<HTMLButtonElement | null>; onOpen(): void };

/**
 * + New task (design contract G53-G59): a Quiet action under the last card of the first column, the only place a task
 * is created, so a new task always lands there. It is drawn at opacity 0 until the column is hovered or holds focus
 * (always on a coarse pointer) and stays focusable while hidden. Desktop app only.
 */
export function NewTaskAction({ triggerRef, onOpen }: NewTaskEntry) {
  return <button ref={triggerRef} type="button" className="commandQuietAction taskColumnAdd" aria-haspopup="dialog" onClick={onOpen}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" /></svg>
    New task
  </button>;
}
