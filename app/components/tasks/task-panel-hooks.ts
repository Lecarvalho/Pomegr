"use client";

import { useEffect, useMemo } from "react";
import { useAgents } from "../../agents-client";
import { modelsByProvider, type TaskModelOptions } from "./task-fields";

/**
 * Models the Models & delegation view already serves (retained agent runs, per provider), read-only.
 * A provider with no observed model offers only its Default model.
 */
export function useTaskModelOptions(): TaskModelOptions {
  const { data } = useAgents({ project: "all", days: 90, scope: "all" });
  const runs = data?.runs;
  return useMemo(() => modelsByProvider(runs ?? []), [runs]);
}

/** Non-modal drawer behavior: Escape closes unless a control inside already handled it (an open list, for instance). */
export function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
}
