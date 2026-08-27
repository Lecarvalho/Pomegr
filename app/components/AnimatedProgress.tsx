"use client";

import { useEffect, useRef, useState } from "react";

type ProgressMotion = "detail" | "compact";

function boundedPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function motionDuration(delta: number, motion: ProgressMotion) {
  return motion === "compact"
    ? Math.min(320, 180 + delta * 2.8)
    : Math.min(900, 500 + delta * 6);
}

function reducedMotionRequested() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useAnimatedProgressValue(value: number, motion: ProgressMotion, animate = true) {
  const target = boundedPercent(value);
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);

  useEffect(() => {
    const from = displayedRef.current;
    const delta = target - from;

    if (!animate || reducedMotionRequested() || Math.abs(delta) < 0.01 || typeof requestAnimationFrame !== "function") {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }

    const duration = motionDuration(Math.abs(delta), motion);
    let frame = 0;
    let startedAt: number | null = null;

    const draw = (timestamp: number) => {
      if (startedAt === null) startedAt = timestamp;
      const elapsed = Math.min(1, (timestamp - startedAt) / duration);
      const exponent = motion === "compact" ? 4 : 3;
      const eased = 1 - Math.pow(1 - elapsed, exponent);
      const next = from + delta * eased;
      displayedRef.current = next;
      setDisplayed(next);

      if (elapsed < 1) {
        frame = requestAnimationFrame(draw);
      } else {
        displayedRef.current = target;
        setDisplayed(target);
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [animate, motion, target]);

  return displayed;
}

export function AnimatedProgressBar({
  value,
  displayedValue,
  label,
  valueText,
  motion,
  blocked = false,
}: {
  value: number;
  displayedValue: number;
  label: string;
  valueText: string;
  motion: ProgressMotion;
  blocked?: boolean;
}) {
  const target = boundedPercent(value);
  const scale = boundedPercent(displayedValue) / 100;

  return (
    <div className={`animatedProgressTrack animatedProgressTrack-${motion}${blocked ? " animatedProgressTrack-blocked" : ""}`}>
      <progress className="animatedProgressSemantic" max={100} value={target} aria-label={label} aria-valuetext={valueText} />
      <span className="animatedProgressFill" style={{ transform: `scaleX(${scale})` }} aria-hidden="true" />
    </div>
  );
}
