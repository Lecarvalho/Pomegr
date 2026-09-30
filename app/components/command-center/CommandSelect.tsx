"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type CommandSelectOption<V extends string | number = string> = {
  value: V;
  label: string;
  /** Decorative glyph shown before the label; describe it with `iconLabel` when it carries meaning. */
  icon?: ReactNode;
  /** Visually hidden text appended to the option's accessible name, for example "running". */
  iconLabel?: string;
};

type CommandSelectProps<V extends string | number> = {
  options: ReadonlyArray<CommandSelectOption<V>>;
  value: V | null | undefined;
  onChange: (value: V) => void;
  "aria-label"?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Trigger text when the value matches no option. */
  placeholder?: string;
};

type ListPosition = { top: number; left: number; minWidth: number; maxHeight: number };

const TYPEAHEAD_RESET_MS = 500;
const EDGE_GAP = 12;
const TRIGGER_GAP = 4;
const MAX_LIST_HEIGHT = 320;

/**
 * Shared single-select dropdown: a select-only combobox whose listbox can show a
 * glyph beside each option, which a native select cannot. Focus stays on the
 * trigger; the active option is announced through aria-activedescendant.
 */
export function CommandSelect<V extends string | number>({ options, value, onChange, "aria-label": ariaLabel, id, disabled = false, className, placeholder = "" }: CommandSelectProps<V>) {
  const [openState, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<ListPosition | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const listId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  // Reserve the glyph column on every row once any option has one, so labels stay aligned.
  const hasIcons = options.some((option) => option.icon);
  const optionId = (index: number) => `${listId}-option-${index}`;
  // Disabling the control while its list is open closes the list.
  const open = openState && !disabled;

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);
  const show = (index: number) => {
    if (disabled || !options.length) return;
    setActiveIndex(Math.min(Math.max(index, 0), options.length - 1));
    // A modal dialog makes everything outside it inert, so the list renders inside it there.
    setHost(triggerRef.current?.closest("dialog") ?? document.body);
    setOpen(true);
  };
  const commit = (index: number) => {
    const option = options[index];
    close();
    if (option && option.value !== value) onChange(option.value);
  };

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!trigger || !list) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - TRIGGER_GAP - EDGE_GAP;
    const above = rect.top - TRIGGER_GAP - EDGE_GAP;
    const natural = Math.min(list.scrollHeight, MAX_LIST_HEIGHT);
    const placeAbove = below < natural && above > below;
    const maxHeight = Math.max(0, Math.min(MAX_LIST_HEIGHT, placeAbove ? above : below));
    const height = Math.min(natural, maxHeight);
    const width = Math.max(rect.width, list.offsetWidth);
    const left = Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - width - EDGE_GAP));
    const top = placeAbove ? rect.top - TRIGGER_GAP - height : rect.bottom + TRIGGER_GAP;
    setPosition({ top, left, minWidth: rect.width, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      updatePosition();
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [close, open]);

  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open, listId]);

  const matchTypeahead = (key: string): number => {
    const now = Date.now();
    const state = typeahead.current;
    state.text = now - state.at > TYPEAHEAD_RESET_MS ? key : state.text + key;
    state.at = now;
    const query = state.text.toLowerCase();
    // Repeating one character cycles through options that start with it.
    const cycling = query.length > 1 && [...query].every((character) => character === query[0]);
    const needle = cycling ? query[0] : query;
    const from = open ? activeIndex : selectedIndex;
    const start = cycling || query.length === 1 ? from + 1 : Math.max(from, 0);
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + offset) % options.length;
      if (options[index].label.toLowerCase().startsWith(needle)) return index;
    }
    return -1;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const last = options.length - 1;
    const current = activeIndex >= 0 ? activeIndex : Math.max(selectedIndex, 0);
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        show(Math.max(selectedIndex, 0));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        show(event.key === "Home" ? 0 : last);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const match = matchTypeahead(event.key);
        if (match >= 0) show(match);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); setActiveIndex(Math.min(current + 1, last)); return;
      case "ArrowUp":
        event.preventDefault();
        if (event.altKey) commit(current);
        else setActiveIndex(Math.max(current - 1, 0));
        return;
      case "Home": event.preventDefault(); setActiveIndex(0); return;
      case "End": event.preventDefault(); setActiveIndex(last); return;
      case "PageDown": event.preventDefault(); setActiveIndex(Math.min(current + 10, last)); return;
      case "PageUp": event.preventDefault(); setActiveIndex(Math.max(current - 10, 0)); return;
      case "Enter": event.preventDefault(); commit(current); return;
      case "Escape": event.preventDefault(); event.stopPropagation(); close(); return;
      case "Tab": close(); return;
      case " ":
        event.preventDefault();
        if (Date.now() - typeahead.current.at < TYPEAHEAD_RESET_MS && typeahead.current.text) {
          const match = matchTypeahead(" ");
          if (match >= 0) setActiveIndex(match);
        } else commit(current);
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const match = matchTypeahead(event.key);
          if (match >= 0) setActiveIndex(match);
        }
    }
  };

  const listStyle: CSSProperties = position
    ? { top: position.top, left: position.left, minWidth: position.minWidth, maxHeight: position.maxHeight }
    : { visibility: "hidden" };

  return <span className={`commandSelect${className ? ` ${className}` : ""}`}>
    <button
      ref={triggerRef}
      id={id}
      type="button"
      role="combobox"
      className="commandSelectTrigger"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
      data-value={selected ? String(selected.value) : ""}
      disabled={disabled}
      onClick={() => (open ? close() : show(Math.max(selectedIndex, 0)))}
      onKeyDown={onKeyDown}
      onBlur={close}
    >
      {selected?.icon && <span className="commandSelectIcon" aria-hidden="true">{selected.icon}</span>}
      <span className="commandSelectValue">{selected ? selected.label : placeholder}</span>
      {selected?.iconLabel && <span className="commandVisuallyHidden">, {selected.iconLabel}</span>}
    </button>
    {open && host && createPortal(
      <ul
        ref={listRef}
        id={listId}
        className="commandSelectList"
        role="listbox"
        aria-label={ariaLabel}
        style={listStyle}
        // Keep focus on the trigger so aria-activedescendant stays meaningful.
        onMouseDown={(event) => event.preventDefault()}
      >
        {options.map((option, index) => <li
          key={String(option.value)}
          id={optionId(index)}
          role="option"
          aria-selected={index === selectedIndex}
          data-value={String(option.value)}
          data-active={index === activeIndex || undefined}
          className="commandSelectOption"
          onPointerMove={() => { if (index !== activeIndex) setActiveIndex(index); }}
          onClick={() => commit(index)}
        >
          {hasIcons && <span className="commandSelectIcon" aria-hidden="true">{option.icon}</span>}
          <span className="commandSelectValue">{option.label}</span>
          {option.iconLabel && <span className="commandVisuallyHidden">, {option.iconLabel}</span>}
        </li>)}
      </ul>,
      host,
    )}
  </span>;
}
