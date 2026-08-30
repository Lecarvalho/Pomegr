import { parseCodexRolloutLiveness } from "./codex-rollout-lifecycle.mjs";

/** The recorded vscode origin is not proof of the branded client currently viewing it. */
export function createVscodeOriginObservation(maximum = 16) {
  let coldReads = 0;
  return {
    coldCandidate(thread) {
      if (thread.parentThreadId || coldReads >= maximum) return false;
      coldReads += 1;
      return true;
    },
    infer: parseCodexRolloutLiveness,
  };
}
