"use client";

import { useEffect, useState } from "react";

const CLOCK_REFRESH_MS = 200;

/**
 * Drives live duration labels from the browser clock. The value freezes when
 * monitoring is paused or disconnected, and resumes from real time only after
 * the backend confirms that the live view is available again.
 */
export function useLiveClock(running: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setNow(Date.now()), CLOCK_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [running]);

  return now;
}
