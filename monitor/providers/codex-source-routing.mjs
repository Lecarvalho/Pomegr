import { createCliObservation } from "./codex-cli-observation.mjs";
import { createVscodeOriginObservation } from "./codex-vscode-origin-observation.mjs";
import { parseCodexRolloutLiveness } from "./codex-rollout-lifecycle.mjs";

const commonObservation = Object.freeze({
  coldCandidate: () => false,
  infer: parseCodexRolloutLiveness,
});

/** Concrete alternatives with independent budgets. Unknown surfaces use only common formats. */
export function createCodexSourceRouter(maximumColdReads = 16) {
  const implementations = new Map([
    ["cli", createCliObservation(maximumColdReads)],
    ["vscode", createVscodeOriginObservation(maximumColdReads)],
  ]);
  return (sourceKind) => implementations.get(sourceKind) || commonObservation;
}

/** Only an adapter's affirmative, per-channel support assessment permits inference. */
export function codexInferenceEligible(availability) {
  return ["owningRuntime", "hooks", "structuredRollout"].every((key) => availability?.[key] === "unsupported");
}
