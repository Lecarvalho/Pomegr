"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useDismissibleLayer } from "../hooks/useDismissibleLayer";

export type DottedInfoPopoverLink = {
  href: string;
  label: ReactNode;
  ariaLabel?: string;
};

type DottedInfoPopoverProps = {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  content: ReactNode;
  link?: DottedInfoPopoverLink;
};

type PopoverPosition = {
  arrowLeft: number;
  left: number;
  placement: "top" | "bottom";
  top: number;
};

/**
 * Compact evidence disclosure for explanatory inline text. The dotted
 * underline is intentionally reserved for text; icons, buttons, and chips
 * should keep their own established affordances. Keep the supplied content
 * factual and use the optional link for longer explanations.
 */
export function DottedInfoPopover({ ariaLabel, children, className = "", content, link }: DottedInfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const pointerTypeRef = useRef<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const popoverId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismissibleLayer(open, triggerRef, close, false);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      const active = document.activeElement;
      if (active !== triggerRef.current && !popoverRef.current?.contains(active)) close();
    }, 100);
  }, [cancelScheduledClose, close]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const edgeGap = 12;
    const triggerGap = 9;
    const placement = triggerRect.top >= popoverRect.height + triggerGap + edgeGap ? "top" : "bottom";
    const desiredLeft = triggerRect.left + (triggerRect.width - popoverRect.width) / 2;
    const left = Math.min(Math.max(edgeGap, desiredLeft), window.innerWidth - popoverRect.width - edgeGap);
    const top = placement === "top"
      ? triggerRect.top - popoverRect.height - triggerGap
      : triggerRect.bottom + triggerGap;
    const arrowLeft = Math.min(Math.max(12, triggerRect.left + triggerRect.width / 2 - left), popoverRect.width - 12);
    setPosition({ arrowLeft, left, placement, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [close, open]);

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && (triggerRef.current?.contains(next) || popoverRef.current?.contains(next))) return;
    scheduleClose();
  };

  const handlePointerEnter = (event: ReactPointerEvent<HTMLElement>) => {
    cancelScheduledClose();
    if (event.pointerType === "mouse") setOpen(true);
  };

  const handlePointerLeave = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") scheduleClose();
  };

  const popoverStyle = position ? {
    "--signal-tooltip-arrow-left": `${position.arrowLeft}px`,
    left: `${position.left}px`,
    top: `${position.top}px`,
  } as CSSProperties : undefined;

  return <span className={`dottedInfoPopoverRoot ${className}`.trim()}>
    <button
      ref={triggerRef}
      className="dottedInfoPopoverTrigger"
      type="button"
      aria-controls={open ? popoverId : undefined}
      aria-expanded={open}
      aria-label={ariaLabel}
      onBlur={handleBlur}
      onClick={(event) => event.stopPropagation()}
      onFocus={() => {
        cancelScheduledClose();
        if (!pointerTypeRef.current) setOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      onPointerCancel={() => { pointerTypeRef.current = null; }}
      onPointerDown={(event) => {
        event.stopPropagation();
        pointerTypeRef.current = event.pointerType;
      }}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerUp={(event) => {
        event.stopPropagation();
        if (event.pointerType !== "mouse") setOpen((value) => !value);
        pointerTypeRef.current = null;
      }}
    >
      <span className="dottedInfoPopoverLabel">{children}</span>
    </button>
    {open && typeof document !== "undefined" && createPortal(
      <span
        ref={popoverRef}
        id={popoverId}
        aria-label={ariaLabel}
        className="tooltipPopover signalTooltip dottedInfoPopoverSurface"
        data-placement={position?.placement || "top"}
        role="dialog"
        style={popoverStyle}
        onBlur={handleBlur}
        onFocus={cancelScheduledClose}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <span className="dottedInfoPopoverContent">{content}</span>
        {link && <a
          className="dottedInfoPopoverLink"
          href={link.href}
          aria-label={link.ariaLabel}
          target="_blank"
          rel="noreferrer"
        >{link.label}<span aria-hidden="true"> ↗</span></a>}
      </span>,
      document.body,
    )}
  </span>;
}
