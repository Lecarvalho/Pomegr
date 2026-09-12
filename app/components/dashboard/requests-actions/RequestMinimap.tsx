import { memo, useMemo, useRef, type PointerEvent } from "react";
import type { RequestOverviewPoint } from "../../../../shared/session-history-contract";
import { isCompleteRequestOverview, plottedTotal, type ChartMode, type RequestRow } from "./model";

const MiniBars = memo(function MiniBars({ values, offset, slotWidth }: { values: number[]; offset: number; slotWidth: number }) {
  const maximum = values.reduce((max, value) => Math.max(max, value), 1);
  return values.map((value, index) => {
    const height = Math.max(.5, value / maximum * 22);
    return <rect key={offset + index} className="requestsActionsMiniBar" x={(offset + index + .175) * slotWidth} y={25 - height} width={slotWidth * .65} height={height} />;
  });
});

export function RequestMinimap({ rows, overview, start, end, total = rows.length, offset = 0, mode, cacheWriteAvailable, onMove, interactive = true }: {
  rows: RequestRow[]; start: number; end: number; mode: ChartMode; cacheWriteAvailable: boolean; onMove: (start: number) => void;
  total?: number; offset?: number; overview?: RequestOverviewPoint[] | null; interactive?: boolean;
}) {
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const completeOverview = useMemo(() => isCompleteRequestOverview(overview, total), [overview, total]);
  const fallbackRows = completeOverview ? null : rows;
  const values = useMemo(() => fallbackRows
    ? fallbackRows.map((row) => plottedTotal(row, mode, cacheWriteAvailable))
    : (overview ?? []).map(([uncached, write, read, output]) => uncached + (cacheWriteAvailable ? write : 0) + (mode === "full" ? read : 0) + output),
  [fallbackRows, overview, mode, cacheWriteAvailable]);
  const barOffset = completeOverview ? 0 : offset;
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
  return <div className={`requestsActionsMinimap${interactive ? "" : " isLoading"}`}>
    <svg viewBox="0 0 1000 26" preserveAspectRatio="none" role={interactive ? "slider" : "img"} aria-label={interactive ? "Request window" : "Request map loading"} tabIndex={interactive ? 0 : undefined} aria-busy={interactive ? undefined : true}
      aria-valuemin={interactive ? 1 : undefined} aria-valuemax={interactive ? lastStart : undefined} aria-valuenow={interactive ? start : undefined} aria-valuetext={interactive ? `Request positions ${start} to ${end} of ${total}` : undefined}
      onKeyDown={(event) => {
        if (!interactive) return;
        const next = event.key === "ArrowLeft" ? start - 1 : event.key === "ArrowRight" ? start + 1 : event.key === "PageUp" ? start - windowSize : event.key === "PageDown" ? start + windowSize : event.key === "Home" ? 1 : event.key === "End" ? lastStart : null;
        if (next !== null) { event.preventDefault(); moveTo(next); }
      }}
      onPointerDown={(event) => {
        if (!interactive || event.button !== 0 || drag.current) return;
        const position = point(event);
        drag.current = { pointerId: event.pointerId, offset: position >= start - 1 && position <= end ? position - (start - 1) : (end - start + 1) / 2 };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        move(event);
      }} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}>
      <MiniBars values={values} offset={barOffset} slotWidth={slotWidth} />
      {rows.map((row, index) => row.cacheEvidence && <line key={row.id} className={`requestsActionsMiniRefill${row.cacheEvidence.kind === "possible_refill" ? " isInferred" : ""}`} x1={(offset + index + .5) * slotWidth} x2={(offset + index + .5) * slotWidth} y1={1} y2={8} />)}
      <rect className={`requestsActionsMiniWindow${start === 1 && end === total ? " isWhole" : ""}`} x={(start - 1) * slotWidth} y={1} width={windowSize * slotWidth} height={24} />
    </svg>
  </div>;
}
