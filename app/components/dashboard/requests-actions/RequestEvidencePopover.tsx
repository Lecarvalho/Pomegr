import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cacheLifetimeInferenceLabel } from "./cache-evidence";
import type { RequestRow } from "./model";

type Position = { arrowLeft: number; left: number; top: number; placement: "top" | "bottom" };

/**
 * Shows the monitor's cache-expiry inference above a hovered or focused refill marker.
 * Native SVG titles appear late and unreliably, so the chart uses the shared tooltip surface.
 */
export function RequestEvidencePopover({ chartRef, row }: { chartRef: RefObject<Element | null>; row: RequestRow | undefined }) {
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const text = cacheLifetimeInferenceLabel(row?.cacheEvidence?.occurrence?.cacheLifetimeInference);
  const id = row?.id;

  useLayoutEffect(() => {
    if (!text || !id) return;
    const update = () => {
      // The inspected bar is marked by class so the markup carries no request IDs.
      const anchor = chartRef.current?.querySelector(".requestsActionsBar.isInspected .cacheRefillIcon");
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const trigger = anchor.getBoundingClientRect();
      const bounds = popover.getBoundingClientRect();
      const edge = 12;
      const gap = 8;
      const placement = trigger.top >= bounds.height + gap + edge ? "top" : "bottom";
      const left = Math.min(Math.max(edge, trigger.left + trigger.width / 2 - bounds.width / 2), window.innerWidth - bounds.width - edge);
      const top = placement === "top" ? trigger.top - bounds.height - gap : trigger.bottom + gap;
      const arrowLeft = Math.min(Math.max(12, trigger.left + trigger.width / 2 - left), bounds.width - 12);
      setPosition({ arrowLeft, left, top, placement });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [chartRef, id, text]);

  if (!text || typeof document === "undefined") return null;
  const style = position
    ? { "--signal-tooltip-arrow-left": `${position.arrowLeft}px`, left: `${position.left}px`, top: `${position.top}px` } as CSSProperties
    : { visibility: "hidden" } as CSSProperties;
  return createPortal(
    <span ref={popoverRef} className="tooltipPopover signalTooltip" role="tooltip" data-placement={position?.placement || "top"} style={style}>
      <span className="tooltipPopoverText">{text}.</span>
    </span>,
    document.body,
  );
}
