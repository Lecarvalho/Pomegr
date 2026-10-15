"use client";

import { useEffect } from "react";

// Lets the hero's dot grid follow the pointer: it writes the pointer position into CSS variables
// on the hero zone, where a red copy of the grid is masked to a circle around it. Touch and
// reduced motion keep the plain grid.
export function DotGlow({ rootId }: { rootId: string }) {
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const paint = () => {
      frame = 0;
      root.style.setProperty("--glow-x", `${x}px`);
      root.style.setProperty("--glow-y", `${y}px`);
    };
    const move = (event: PointerEvent) => {
      const box = root.getBoundingClientRect();
      x = event.clientX - box.left;
      y = event.clientY - box.top;
      root.setAttribute("data-glow", "");
      if (!frame) frame = window.requestAnimationFrame(paint);
    };
    const leave = () => root.removeAttribute("data-glow");
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerleave", leave);
    return () => {
      window.cancelAnimationFrame(frame);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
    };
  }, [rootId]);

  return null;
}
