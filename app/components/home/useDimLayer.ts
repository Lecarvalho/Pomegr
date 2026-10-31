"use client";

import { useCallback, useEffect, useState } from "react";
import { onPhone, prefersLessMotion } from "./home-media";

/** How long the layer fades in and out on a phone. It is the time of the content's own fade (HomeDashboard.module.css). */
export const DIM_FADE_MS = 280;
/** The layer is taken away this long after its fade should have ended, if the browser never says that it did. */
const DIM_FALLBACK_MS = DIM_FADE_MS + 60;

export type DimLayer = {
  /** Whether the layer is in the page: in focus mode, and for the fade after it. */
  present: boolean;
  /** Whether the layer is fading out because focus mode ended. */
  leaving: boolean;
  /** To call when the fade-out ends. */
  end(): void;
};

/**
 * The layer that covers the page in focus mode. On a phone it is opaque, so a hard cut of it is a blink: it fades in with the content's fade, and it stays in the page while it
 * fades out when Home comes back. It goes at once where nothing fades: the desktop (its layer is transparent), reduced motion, and Send, which hands the screen to the panel.
 */
export function useDimLayer(mode: string): DimLayer {
  const [leaving, setLeaving] = useState(false);
  const [last, setLast] = useState(mode);
  if (last !== mode) {
    setLast(mode);
    setLeaving(last === "focus" && mode === "home" && onPhone() && !prefersLessMotion());
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(false), DIM_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const end = useCallback(() => setLeaving(false), []);
  return { present: mode === "focus" || leaving, leaving, end };
}
