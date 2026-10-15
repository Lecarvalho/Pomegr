"use client";

import { useEffect, useRef } from "react";
import styles from "./LandingPage.module.css";

const GRID = 22;
const RADIUS = 1.8;
const LIFE_MS = 1100;
const COLOR = "229, 103, 91";

// Lights the hero grid's dots that the pointer actually crosses, one dot at a time, and lets
// each fade out. The canvas carries the grid's own fade mask. Touch and reduced motion skip it.
export function DotGlow({ rootId }: { rootId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = document.getElementById(rootId);
    const surface = canvas.current;
    const context = surface?.getContext("2d");
    if (!root || !surface || !context) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lit = new Map<string, { x: number; y: number; at: number }>();
    let frame = 0;
    let last: { x: number; y: number } | null = null;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      surface.width = surface.clientWidth * ratio;
      surface.height = surface.clientHeight * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (now: number) => {
      context.clearRect(0, 0, surface.clientWidth, surface.clientHeight);
      for (const [key, dot] of lit) {
        const left = 1 - (now - dot.at) / LIFE_MS;
        if (left <= 0) { lit.delete(key); continue; }
        context.fillStyle = `rgba(${COLOR}, ${left * left})`;
        context.beginPath();
        context.arc(dot.x, dot.y, RADIUS, 0, Math.PI * 2);
        context.fill();
      }
      frame = lit.size ? window.requestAnimationFrame(draw) : 0;
    };

    // The background grid draws each dot at the centre of a 22 px tile.
    const light = (x: number, y: number, now: number) => {
      const column = Math.floor(x / GRID);
      const row = Math.floor(y / GRID);
      const centerX = column * GRID + GRID / 2;
      const centerY = row * GRID + GRID / 2;
      if (Math.hypot(x - centerX, y - centerY) > GRID * 0.42) return;
      lit.set(`${column}:${row}`, { x: centerX, y: centerY, at: now });
    };

    const move = (event: PointerEvent) => {
      const box = surface.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const now = performance.now();
      // Walk the segment since the last event so a fast stroke still lights every dot it crosses.
      const from = last ?? point;
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - from.x, point.y - from.y) / 4));
      for (let step = 1; step <= steps; step += 1) {
        light(from.x + ((point.x - from.x) * step) / steps, from.y + ((point.y - from.y) * step) / steps, now);
      }
      last = point;
      if (!frame) frame = window.requestAnimationFrame(draw);
    };
    const leave = () => { last = null; };

    resize();
    window.addEventListener("resize", resize);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerleave", leave);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
    };
  }, [rootId]);

  return <canvas ref={canvas} className={styles.dotGlow} aria-hidden="true" />;
}
