import { useRef, type PointerEvent } from "react";
import { plottedTotal, type ChartMode, type RequestRow } from "./model";

export function RequestMinimap({ rows, start, end, total = rows.length, offset = 0, mode, cacheWriteAvailable, onMove }: {
  rows: RequestRow[]; start: number; end: number; mode: ChartMode; cacheWriteAvailable: boolean; onMove: (start: number) => void;
  total?: number; offset?: number;
}) {
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const maximum = Math.max(1, ...rows.map((row) => plottedTotal(row, mode, cacheWriteAvailable)));
  const slotWidth = 1000 / Math.max(1, total);
  const windowSize = end - start + 1;
  const lastStart = Math.max(1, total - windowSize + 1);
  const moveTo = (value: number) => onMove(Math.max(1, Math.min(lastStart, Math.round(value))));
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(total, (event.clientX - bounds.left) / Math.max(1, bounds.width) * total));
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === event.pointerId) moveTo(point(event) - drag.current.offset + 1);
  };
  const finish = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className="requestsActionsMinimap">
    <svg viewBox="0 0 1000 26" preserveAspectRatio="none" role="slider" aria-label="Request window" tabIndex={0}
      aria-valuemin={1} aria-valuemax={lastStart} aria-valuenow={start} aria-valuetext={`Request positions ${start} to ${end} of ${total}`}
      onKeyDown={(event) => {
        const next = event.key === "ArrowLeft" ? start - 1 : event.key === "ArrowRight" ? start + 1 : event.key === "PageUp" ? start - windowSize : event.key === "PageDown" ? start + windowSize : event.key === "Home" ? 1 : event.key === "End" ? lastStart : null;
        if (next !== null) { event.preventDefault(); moveTo(next); }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        const position = point(event);
        drag.current = { pointerId: event.pointerId, offset: position >= start - 1 && position <= end ? position - (start - 1) : (end - start + 1) / 2 };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        move(event);
      }} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}>
      {rows.map((row, index) => {
        const height = Math.max(.5, plottedTotal(row, mode, cacheWriteAvailable) / maximum * 22);
        return <g key={row.id}>
          <rect className="requestsActionsMiniBar" x={(offset + index + .175) * slotWidth} y={25 - height} width={slotWidth * .65} height={height} />
          {row.cacheEvidence && <line className={`requestsActionsMiniRefill${row.cacheEvidence.kind === "possible_refill" ? " isInferred" : ""}`} x1={(offset + index + .5) * slotWidth} x2={(offset + index + .5) * slotWidth} y1={1} y2={8} />}
        </g>;
      })}
      <rect className={`requestsActionsMiniWindow${start === 1 && end === total ? " isWhole" : ""}`} x={(start - 1) * slotWidth} y={1} width={windowSize * slotWidth} height={24} />
    </svg>
  </div>;
}
