"use client";

import { useMemo } from "react";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { useTasks } from "../../tasks-store";
import { sessionTaskModel, type SessionTaskModel } from "./session-task-model";

export function useSessionTask(reference: SessionTaskReference): SessionTaskModel {
  const { board } = useTasks(reference.repositoryId);
  return useMemo(() => sessionTaskModel(board, reference), [board, reference]);
}
