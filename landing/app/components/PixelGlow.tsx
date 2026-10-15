"use client";

import { useEffect, useRef } from "react";
import styles from "./LandingPage.module.css";

// The closing image is a 300 px wide dither shown at the image's width, so one dither pixel is
// 1/300 of it. The pointer reveals the image on that same grid.
const DITHER_COLUMNS = 300;
const LIFE_MS = 2000;
const REACH = 13;

// Under a fine pointer the closing image stays hidden, and the pointer reveals it: the dither
// pixels around its path show the image and fade out again. The canvas carries the image's own top
// and bottom fade. Touch and reduced motion skip it and show the whole image.
export function PixelGlow({ rootId }: { rootId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = document.getElementById(rootId);
    const surface = canvas.current;
    const context = surface?.getContext("2d");
    const image = root?.querySelector("img");
    if (!root || !surface || !context || !image) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lit = new Map<string, { column: number; row: number; at: number }>();
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

    // Each frame paints the lit cells as an alpha mask, then keeps only the image inside it.
    const draw = (now: number) => {
      const width = surface.clientWidth;
      const height = surface.clientHeight;
      context.globalCompositeOperation = "source-over";
      context.clearRect(0, 0, width, height);
      for (const [key, pixel] of lit) {
        const left = 1 - (now - pixel.at) / LIFE_MS;
        if (left <= 0) { lit.delete(key); continue; }
        context.fillStyle = `rgba(0, 0, 0, ${left * left})`;
        // Snap to whole pixels so neighbouring squares never leave a seam.
        const x = Math.round(pixel.column * cell);
        const y = Math.round(pixel.row * cell);
        context.fillRect(x, y, Math.round((pixel.column + 1) * cell) - x, Math.round((pixel.row + 1) * cell) - y);
      }
      context.globalCompositeOperation = "source-in";
      context.drawImage(image, 0, 0, width, height);
      context.globalCompositeOperation = "source-over";
      frame = lit.size ? window.requestAnimationFrame(draw) : 0;
    };

    // The core around the pointer always reveals; farther cells reveal more rarely, so the edge dithers.
    const light = (x: number, y: number, now: number) => {
      const column = Math.floor(x / cell);
      const row = Math.floor(y / cell);
      for (let dy = -REACH; dy <= REACH; dy += 1) {
        for (let dx = -REACH; dx <= REACH; dx += 1) {
          const distance = Math.hypot(dx, dy) / REACH;
          if (distance > 1) continue;
          if (distance > .45 && Math.random() > (1 - distance) / .55) continue;
          lit.set(`${column + dx}:${row + dy}`, { column: column + dx, row: row + dy, at: now });
        }
      }
    };

    const move = (event: PointerEvent) => {
      const box = surface.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const now = performance.now();
      // Walk the segment since the last event so a fast stroke still reveals every pixel it crosses.
      const from = last ?? point;
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - from.x, point.y - from.y) / (cell * 2)));
      for (let step = 1; step <= steps; step += 1) {
        light(from.x + ((point.x - from.x) * step) / steps, from.y + ((point.y - from.y) * step) / steps, now);
      }
      last = point;
      if (!frame) frame = window.requestAnimationFrame(draw);
    };
    const leave = () => { last = null; };

    resize();
    root.setAttribute("data-pointer-reveal", "");
    window.addEventListener("resize", resize);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerleave", leave);
    return () => {
      window.cancelAnimationFrame(frame);
      root.removeAttribute("data-pointer-reveal");
      window.removeEventListener("resize", resize);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
    };
  }, [rootId]);

  return <canvas ref={canvas} className={styles.pixelGlow} aria-hidden="true" />;
}
