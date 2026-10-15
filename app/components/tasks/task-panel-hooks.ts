"use client";

import { useEffect, useMemo, useState } from "react";
import { useAgents } from "../../agents-client";
import type { TaskBoard } from "../../../shared/task-contract";
import { RUN_MODEL_AGENTS_QUERY } from "../../../shared/task-run-models.mjs";
import { modelsByProvider, type TaskModelOptions } from "./task-fields";

export function useTaskModelOptions(runModels?: NonNullable<TaskBoard["runModels"]>): TaskModelOptions {
  const { data } = useAgents(RUN_MODEL_AGENTS_QUERY);
  const runs = data?.runs;
  const codex = runModels?.codex;
  return useMemo(() => modelsByProvider(runs ?? [], codex ?? []), [runs, codex]);
}

export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}
