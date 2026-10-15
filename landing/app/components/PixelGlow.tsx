"use client";

import { useEffect, useRef } from "react";
import styles from "./LandingPage.module.css";

// The closing image is a 300 px wide dither shown at the image's width, so one dither pixel is
// 1/300 of it. Lit squares use that same grid and the image's three reds.
const DITHER_COLUMNS = 300;
const LIFE_MS = 1100;
const REACH = 3;
const REDS = ["92, 32, 27", "166, 60, 50", "229, 103, 91", "229, 103, 91"];

// Lights dither pixels around the pointer while it crosses the closing image, and lets each fade
// out. The canvas carries the image's own top and bottom fade. Touch and reduced motion skip it.
export function PixelGlow({ rootId }: { rootId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = document.getElementById(rootId);
    const surface = canvas.current;
    const context = surface?.getContext("2d");
    if (!root || !surface || !context) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lit = new Map<string, { column: number; row: number; color: string; at: number }>();
    let frame = 0;
    let last: { x: number; y: number } | null = null;
    let cell = 4;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      surface.width = surface.clientWidth * ratio;
      surface.height = surface.clientHeight * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.imageSmoothingEnabled = false;
      cell = surface.clientWidth / DITHER_COLUMNS;
    };

    const draw = (now: number) => {
      context.clearRect(0, 0, surface.clientWidth, surface.clientHeight);
      for (const [key, pixel] of lit) {
        const left = 1 - (now - pixel.at) / LIFE_MS;
        if (left <= 0) { lit.delete(key); continue; }
        context.fillStyle = `rgba(${pixel.color}, ${left * left})`;
        // Snap to whole device pixels so neighbouring squares never leave a seam.
        const x = Math.round(pixel.column * cell);
        const y = Math.round(pixel.row * cell);
        context.fillRect(x, y, Math.round((pixel.column + 1) * cell) - x, Math.round((pixel.row + 1) * cell) - y);
      }
      frame = lit.size ? window.requestAnimationFrame(draw) : 0;
    };

    // The crossed pixel always lights; its neighbours light more rarely the farther they are, like the dither.
    const light = (x: number, y: number, now: number) => {
      const column = Math.floor(x / cell);
      const row = Math.floor(y / cell);
      for (let dy = -REACH; dy <= REACH; dy += 1) {
        for (let dx = -REACH; dx <= REACH; dx += 1) {
          const distance = Math.hypot(dx, dy);
          if (distance > REACH + .5) continue;
          if (distance > 0 && Math.random() > .55 * (1 - distance / (REACH + 1))) continue;
          const key = `${column + dx}:${row + dy}`;
          const color = lit.get(key)?.color ?? REDS[Math.floor(Math.random() * REDS.length)];
          lit.set(key, { column: column + dx, row: row + dy, color, at: now });
        }
      }
    };

    const move = (event: PointerEvent) => {
      const box = surface.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const now = performance.now();
      // Walk the segment since the last event so a fast stroke still lights every pixel it crosses.
      const from = last ?? point;
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - from.x, point.y - from.y) / cell));
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

  return <canvas ref={canvas} className={styles.pixelGlow} aria-hidden="true" />;
}
