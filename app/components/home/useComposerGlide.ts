"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { onPhone, prefersLessMotion } from "./home-media";

// How the composer block of Home moves between its two places on a phone: the sticky place at the bottom of Home, and the fixed place of focus mode, above where the keyboard will open (focus-place.ts).
// The block changes its positioning when focus mode starts and ends (HomeAril.module.css), and a change of positioning moves a block in one frame. So the block is
// measured before and after the change and glides from where it was to where it is (FLIP): the glide is a transform that runs from the offset between the two places
// to none. The desktop moves the same block with a transition on a measured shift, over the same time and with the same curve.

/** The time and the curve of the move. They are the transition of `.aril` in HomeAril.module.css, which the desktop uses. */
export const GLIDE_MS = 480;
export const GLIDE_EASE = "cubic-bezier(.2, .8, .2, 1)";

type Place = { left: number; top: number };

/** Where the composer itself is on the screen: the chips above it and the controls under it move with it, so they do not decide the offset. */
function placeOf(block: HTMLElement): Place {
  const rect = (block.querySelector(".agentChatComposer") ?? block).getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

/**
 * The block of the composer, and a way to say where it is now. Call `mark` with the mode that is about to start, in the same event that starts it and before the
 * mode changes: the next render reads the block from its new place, and a glide runs from the marked place. A mark whose mode never starts is ignored. On the desktop,
 * and with reduced motion, there is no glide. A glide that is still running when the next mark is made starts from where the block is on the screen at that moment.
 */
export function useComposerGlide(mode: string) {
  const block = useRef<HTMLElement>(null);
  const marked = useRef<{ place: Place; mode: string } | null>(null);
  const running = useRef<Animation | null>(null);

  const mark = useCallback((next: string) => {
    const element = block.current;
    if (element && onPhone()) marked.current = { place: placeOf(element), mode: next };
  }, []);

  useLayoutEffect(() => {
    const element = block.current;
    const start = marked.current;
    marked.current = null;
    // The block is measured at its new place, so a running glide stops first: its transform would be part of the measure.
    running.current?.cancel();
    running.current = null;
    if (!element || start === null || start.mode !== mode || !onPhone() || prefersLessMotion() || typeof element.animate !== "function") return;
    const end = placeOf(element);
    const dx = start.place.left - end.left;
    const dy = start.place.top - end.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    running.current = element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: GLIDE_MS, easing: GLIDE_EASE });
  }, [mode]);

  return { block, mark };
}
