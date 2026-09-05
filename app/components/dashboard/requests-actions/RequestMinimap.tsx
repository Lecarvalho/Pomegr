import { useRef, type PointerEvent } from "react";
import type { ChartMode, RequestRow } from "./model";

export function RequestMinimap({ rows, start, end, mode, onMove }: {
  rows: RequestRow[]; start: number; end: number; mode: ChartMode; onMove: (start: number) => void;
}) {
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const maximum = Math.max(1, ...rows.map((row) => mode === "fresh" ? row.freshTokens : row.promptTokens));
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(rows.length, (event.clientX - bounds.left) / Math.max(1, bounds.width) * rows.length));
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === event.pointerId) onMove(Math.round(point(event) - drag.current.offset) + 1);
  };
  const finish = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className="requestsActionsMinimap"><span>All {rows.length.toLocaleString()}</span>
    <svg viewBox="0 0 1000 26" preserveAspectRatio="none" role="slider" aria-label="Request window" tabIndex={0}
      aria-valuemin={1} aria-valuemax={Math.max(1, rows.length - (end - start))} aria-valuenow={start} aria-valuetext={`Requests ${start} to ${end}`}
      onKeyDown={(event) => {
        const next = event.key === "ArrowLeft" ? start - 1 : event.key === "ArrowRight" ? start + 1 : event.key === "Home" ? 1 : event.key === "End" ? rows.length : null;
        if (next !== null) { event.preventDefault(); onMove(next); }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const position = point(event);
        drag.current = { pointerId: event.pointerId, offset: position >= start - 1 && position <= end ? position - (start - 1) : (end - start + 1) / 2 };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        move(event);
      }} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}>
      {rows.map((row, index) => {
        const height = Math.max(.5, (mode === "fresh" ? row.freshTokens : row.promptTokens) / maximum * 22);
        return <rect className="requestsActionsMiniBar" key={row.id} x={index / rows.length * 1000} y={25 - height} width={.7} height={height} />;
      })}
      <rect className="requestsActionsMiniWindow" x={(start - 1) / rows.length * 1000} y={1} width={(end - start + 1) / rows.length * 1000} height={24} />
    </svg>
  </div>;
}
