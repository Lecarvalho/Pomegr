"use client";

import { useEffect, useMemo, useState } from "react";
import { useAgents } from "../../agents-client";
import type { TaskBoard } from "../../../shared/task-contract";
import { modelsByProvider, type TaskModelOptions } from "./task-fields";

/**
 * Claude models come from retained agent runs (Models & delegation); Codex models from the board's committed
 * client catalog. A provider with none offers only its Default model.
 */
export function useTaskModelOptions(runModels?: NonNullable<TaskBoard["runModels"]>): TaskModelOptions {
  const { data } = useAgents({ project: "all", days: 90, scope: "all" });
  const runs = data?.runs;
  const codex = runModels?.codex;
  return useMemo(() => modelsByProvider(runs ?? [], codex ?? []), [runs, codex]);
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

/** The clock in epoch milliseconds, read once and again every minute, for lines that say whether a time has passed. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}
