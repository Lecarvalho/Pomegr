"use client";

import { useMemo } from "react";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { useTasks } from "../../tasks-store";
import { sessionTaskModel, type SessionTaskModel } from "./session-task-model";

/** The session's task joined with the committed board of its repository. Reads only; the board store polls for us. */
export function useSessionTask(reference: SessionTaskReference): SessionTaskModel {
  const { board } = useTasks(reference.repositoryId);
  return useMemo(() => sessionTaskModel(board, reference), [board, reference]);
}
