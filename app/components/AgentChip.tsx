"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismissibleLayer } from "../hooks/useDismissibleLayer";

type AgentChipProps = {
  as?: "span" | "button";
  children: ReactNode;
  className?: string;
  title?: string;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
};

export function AgentChip({ as = "span", children, className = "", title, onClick, expanded, controls }: AgentChipProps) {
  const classes = `agentChip ${as === "button" ? "agentChipButton" : ""} ${className}`.trim();
  if (as === "button") return (
    <button className={classes} type="button" onClick={onClick} aria-expanded={expanded} aria-controls={controls}>
      <span className="agentChipLabel">{children}</span>
    </button>
  );
  if (title) return <TooltippedAgentChip classes={classes} tooltip={title}>{children}</TooltippedAgentChip>;
  return <span className={classes}><span className="agentChipLabel">{children}</span></span>;
}

type TooltipPosition = {
  arrowLeft: number;
  left: number;
  placement: "top" | "bottom";
  top: number;
};

function TooltippedAgentChip({ children, classes, tooltip }: { children: ReactNode; classes: string; tooltip: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const pointerTypeRef = useRef<string | null>(null);
  const tooltipId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismissibleLayer(open, triggerRef, close);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltipElement = tooltipRef.current;
    if (!trigger || !tooltipElement) return;
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltipElement.getBoundingClientRect();
    const edgeGap = 12;
    const triggerGap = 9;
    const placement = triggerRect.top >= tooltipRect.height + triggerGap + edgeGap ? "top" : "bottom";
    const desiredLeft = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
    const left = Math.min(Math.max(edgeGap, desiredLeft), window.innerWidth - tooltipRect.width - edgeGap);
    const top = placement === "top"
      ? triggerRect.top - tooltipRect.height - triggerGap
      : triggerRect.bottom + triggerGap;
    const arrowLeft = Math.min(Math.max(12, triggerRect.left + triggerRect.width / 2 - left), tooltipRect.width - 12);
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

  const tooltipStyle = position ? {
    "--signal-tooltip-arrow-left": `${position.arrowLeft}px`,
    left: `${position.left}px`,
    top: `${position.top}px`,
  } as CSSProperties : undefined;

  return <>
    <button
      ref={triggerRef}
      className={`${classes} agentChipTooltipTrigger`}
      type="button"
      aria-describedby={open ? tooltipId : undefined}
      aria-expanded={open}
      onBlur={close}
      onFocus={() => {
        if (!pointerTypeRef.current) setOpen(true);
      }}
      onPointerCancel={() => { pointerTypeRef.current = null; }}
      onPointerDown={(event) => { pointerTypeRef.current = event.pointerType; }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && document.activeElement !== triggerRef.current) close();
      }}
      onPointerUp={(event) => {
        if (event.pointerType !== "mouse") setOpen((value) => !value);
        pointerTypeRef.current = null;
      }}
    >
      <span className="agentChipLabel">{children}</span>
    </button>
    {open && typeof document !== "undefined" && createPortal(
      <span
        ref={tooltipRef}
        id={tooltipId}
        className="signalTooltip"
        data-placement={position?.placement || "top"}
        role="tooltip"
        style={tooltipStyle}
      >{tooltip}</span>,
      document.body,
    )}
  </>;
}
