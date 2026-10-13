"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export type CommandSplitItem<V extends string = string> = {
  value: V;
  label: string;
  /** One muted line under the label that says what the action does. */
  detail?: string;
};

/** A Primary action with a caret that opens a menu of its other forms. See DESIGN.md "Split action". */
export function CommandSplitAction<V extends string>({ label, menuLabel, items, disabled = false, onAction, onSelect }: {
  label: string;
  /** Names the caret and its menu, such as "More ways to create". */
  menuLabel: string;
  items: ReadonlyArray<CommandSplitItem<V>>;
  disabled?: boolean;
  onAction(): void;
  onSelect(value: V): void;
}) {
  const [openState, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const open = openState && !disabled;

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    caret.current?.focus({ preventScroll: true });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      // The menu handles the key, so a dialog around it stays open.
      event.preventDefault();
      close();
      return;
    }
    const entries = [...(menu.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (at + 1) % entries.length : event.key === "ArrowUp" ? (at - 1 + entries.length) % entries.length
      : event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    entries[next]?.focus({ preventScroll: true });
  };

  return <div ref={root} className="commandSplitAction" onKeyDown={keyDown}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className="commandPrimaryAction" disabled={disabled} onClick={onAction}>{label}</button>
    <button ref={caret} type="button" className="commandPrimaryAction commandSplitCaret" disabled={disabled} aria-label={menuLabel} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <div ref={menu} id={menuId} className="commandSplitMenu" role="menu" aria-label={menuLabel}>
      {items.map((item) => <button key={item.value} type="button" role="menuitem" tabIndex={-1} onClick={() => { close(); onSelect(item.value); }}>
        <span>{item.label}</span>
        {item.detail && <small>{item.detail}</small>}
      </button>)}
    </div>}
  </div>;
}
