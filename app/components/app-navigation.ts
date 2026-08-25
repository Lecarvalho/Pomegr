"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const OPEN_NAVIGATION_EVENT = "pomegr:open-navigation";
const NAVIGATION_STATE_EVENT = "pomegr:navigation-state";

export function subscribeToOpenNavigation(listener: () => void) {
  window.addEventListener(OPEN_NAVIGATION_EVENT, listener);
  return () => window.removeEventListener(OPEN_NAVIGATION_EVENT, listener);
}

export function publishNavigationState(open: boolean) {
  window.dispatchEvent(new CustomEvent(NAVIGATION_STATE_EVENT, { detail: { open } }));
}

export function useAppNavigation() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const update = (event: Event) => setOpen(Boolean((event as CustomEvent<{ open?: boolean }>).detail?.open));
    window.addEventListener(NAVIGATION_STATE_EVENT, update);
    return () => window.removeEventListener(NAVIGATION_STATE_EVENT, update);
  }, []);
  const openNavigation = useCallback(() => window.dispatchEvent(new Event(OPEN_NAVIGATION_EVENT)), []);
  return useMemo(() => ({ open, openNavigation }), [open, openNavigation]);
}
