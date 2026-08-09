"use client";

import { useEffect, type RefObject } from "react";

export function useDismissibleLayer(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  outsidePointer = true,
) {
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (outsidePointer && !containerRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    if (outsidePointer) document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      if (outsidePointer) document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [containerRef, onClose, open, outsidePointer]);
}
