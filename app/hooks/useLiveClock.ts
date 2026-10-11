"use client";

import { useEffect, useState } from "react";

const CLOCK_REFRESH_MS = 200;

export function useLiveClock(running: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setNow(Date.now()), CLOCK_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [running]);

  return now;
}
