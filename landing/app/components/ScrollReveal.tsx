"use client";

import { useEffect } from "react";

// Marks each `[data-reveal]` element with `data-shown` the first time it scrolls into view, so its
// CSS entrance runs once. The page renders complete without this script: the hidden starting
// states apply only under `[data-motion]`, which is set here and never for reduced motion.
export function ScrollReveal({ rootId }: { rootId: string }) {
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const targets = [...root.querySelectorAll<HTMLElement>("[data-reveal]")];
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute("data-shown", "");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -15% 0px" });
    root.setAttribute("data-motion", "");
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [rootId]);

  return null;
}
