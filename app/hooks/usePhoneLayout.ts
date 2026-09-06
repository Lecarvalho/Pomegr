import { useSyncExternalStore } from "react";

const PHONE_QUERY = "(max-width: 760px)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(PHONE_QUERY);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

export function usePhoneLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(PHONE_QUERY).matches ?? false, () => false);
}
