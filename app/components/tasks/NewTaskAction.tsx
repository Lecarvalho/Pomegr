"use client";

import type { RefObject } from "react";

export type NewTaskEntry = { triggerRef: RefObject<HTMLButtonElement | null>; onOpen(): void };

export function NewTaskAction({ triggerRef, onOpen }: NewTaskEntry) {
  return <button ref={triggerRef} type="button" className="commandQuietAction taskColumnAdd" aria-haspopup="dialog" onClick={onOpen}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" /></svg>
    New task
  </button>;
}
