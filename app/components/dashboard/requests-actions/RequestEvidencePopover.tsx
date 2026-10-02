import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { cacheRefillEvidenceView } from "../AgentHistoryIndicators";
import { CacheEvidencePopover } from "../CacheEvidencePopover";
import { cacheLifetimeInferenceLabel, refillEvidenceCounts } from "./cache-evidence";
import { requestMarker, type RequestRow } from "./model";

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

/** Props shared by the request refill popover and its static design-system sample; null without a matched occurrence. */
export function requestRefillPopoverProps(row: RequestRow, id: string, onClose: () => void) {
  const occurrence = row.cacheEvidence?.occurrence;
  if (!occurrence) return null;
  const view = cacheRefillEvidenceView(refillEvidenceCounts(row.agentId, occurrence), [row.agentId]);
  return {
    id, ariaLabel: "Cache refill evidence", eyebrow: "Cache evidence", title: view.title, summary: view.summary, children: view.body, onClose,
    closeLabel: `Close cache refill evidence for request ${requestMarker(row)}`,
  };
}

/**
 * The same refill evidence the Agents tab shows, opened from a request marker. The anchor is the
 * marker's SVG element: the popover reads only its geometry, so it stands in for the Agents-tab span.
 */
export function RequestRefillPopover({ row, id, anchorRef, onClose }: {
  row: RequestRow; id: string; anchorRef: RefObject<SVGGElement | null>; onClose: () => void;
}) {
  const props = requestRefillPopoverProps(row, id, onClose);
  // React bubbles portal events to the chart: keep drags and arrow keys inside the popover from moving its window.
  const contain = (event: SyntheticEvent) => event.stopPropagation();
  return props ? <g onPointerDown={contain} onPointerMove={contain} onPointerUp={contain} onPointerCancel={contain} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <CacheEvidencePopover {...props} className="cacheRefillPopover" anchorRef={anchorRef} />
  </g> : null;
}
