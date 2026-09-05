"use client";

import { useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { PopoverFrame } from "../PopoverFrame";

/** Keep cache evidence next to its mark, outside clipped or zoomed tree rows. */
export function CacheEvidencePopover({ anchorRef, onClose, ...props }: ComponentProps<typeof PopoverFrame> & {
  anchorRef: RefObject<HTMLSpanElement | null>;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useDismissibleLayer(true, surfaceRef, onClose, false);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const surface = surfaceRef.current;
    if (!anchor || !surface) return;
    const update = () => {
      const trigger = anchor.getBoundingClientRect();
      const bounds = surface.getBoundingClientRect();
      const edge = 12;
      const gap = 8;
      const mobileRow = window.innerWidth <= 640 ? anchor.closest(".rosterRow") : null;
      const desiredLeft = mobileRow?.getBoundingClientRect().left ?? trigger.left;
      const left = Math.max(edge, Math.min(desiredLeft, window.innerWidth - bounds.width - edge));
      const below = trigger.bottom + gap;
      const above = trigger.top - bounds.height - gap;
      const desiredTop = below + bounds.height <= window.innerHeight - edge || above < edge ? below : above;
      const top = Math.max(edge, Math.min(desiredTop, window.innerHeight - bounds.height - edge));
      setPosition((previous) => previous?.left === left && previous.top === top ? previous : { left, top });
    };
    const outside = (event: PointerEvent) => {
      if (!anchor.contains(event.target as Node) && !surface.contains(event.target as Node)) onClose();
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(surface);
    observer?.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    document.addEventListener("pointerdown", outside);
    // A tree camera can move its trigger without scrolling a DOM container.
    const closeOnWheel = (event: WheelEvent) => {
      if (!surface.contains(event.target as Node) && anchor.closest(".agentTreeView-columns")) onClose();
    };
    document.addEventListener("wheel", closeOnWheel, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("wheel", closeOnWheel);
    };
  }, [anchorRef, onClose]);

  return createPortal(<PopoverFrame {...props} onClose={onClose} containerRef={surfaceRef} style={{
    left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden",
  }} />, document.body);
}
