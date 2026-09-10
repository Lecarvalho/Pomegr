import { useRef, type MouseEvent, type PointerEvent } from "react";

/** Drag the visible request window while leaving vertical pan and pinch zoom native. */
export function useRequestChartDrag(enabled: boolean, start: number, total: number, size: number, onMove: (start: number) => void) {
  const gesture = useRef<{ id: number; x: number; y: number; start: number; slot: number; dragging: boolean; last: number } | null>(null);
  const suppressClick = useRef(false);
  const finish = (event: PointerEvent<SVGSVGElement>) => {
    if (gesture.current?.id !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
      if (!enabled || event.button !== 0 || gesture.current || event.isPrimary === false) return;
      suppressClick.current = false;
      const width = event.currentTarget.getBoundingClientRect().width;
      if (width <= 0) return;
      // Match the phone SVG's plot width and gap, excluding its value axis.
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start, slot: width / 334 * (330 - 34 + 2.8) / size, dragging: false, last: start };
    },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
      const active = gesture.current;
      if (!enabled || !active || active.id !== event.pointerId) return;
      const dx = event.clientX - active.x;
      const dy = event.clientY - active.y;
      if (!active.dragging) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
        if (Math.abs(dy) >= Math.abs(dx)) { gesture.current = null; return; }
        active.dragging = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      const next = Math.max(1, Math.min(Math.max(1, total - size + 1), active.start - Math.round(dx / active.slot)));
      if (next !== active.last) { active.last = next; onMove(next); }
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: (event: PointerEvent<SVGSVGElement>) => {
      // Touch starts with implicit capture on the bar; ignore its transfer to the chart.
      if (event.target === event.currentTarget) finish(event);
    },
    onClickCapture: (event: MouseEvent<SVGSVGElement>) => {
      if (suppressClick.current && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      }
    },
  };
}
