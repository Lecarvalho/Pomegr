import { projectProviderSessionEvidence } from "../domain/session-projection.mjs";
import { createSessionReadiness } from "../../normalize/observation-readiness.mjs";
import { resolveCheckpointRepository } from "../../repository/repository-snapshot.mjs";

export function createCheckpointStateProjector({
  registry, recordedSnapshot, recordedGitState, unavailableGitState,
  unavailablePullRequests, repositoryRoleMappings, createEmptyMonitorState,
  createEmptyUsageLimits, unavailableResourceUsage,
} = {}) {
  return ({ providerId, localSessionId, evidence }) => {
    const provider = registry.providers?.find((candidate) => candidate.id === providerId) || registry.defaultProvider;
    const historical = Boolean(evidence.historical);
    const sessionId = `${providerId}:${localSessionId}`;
    try {
      const { repository, pullRequests } = resolveCheckpointRepository({
        historical, evidence, snapshot: recordedSnapshot(sessionId),
        adoptsUnboundSidecar: registry.legacyRepositoryAttribution?.(providerId) === "launch",
        recordedGitState, unavailableGitState, unavailablePullRequests,
      });
      return {
        ...projectProviderSessionEvidence({
          evidence, sessionId, source: provider.source, capabilities: provider.capabilities,
          // The session identity's resolved root never travels through evidence or
          // checkpoints (see server/normalize/session-identity.mjs), so this restore path reads role
          // configuration only from legacy "launch" evidence's launch cwd, as before the rule;
          // live analysis re-projects roles from the identity's root.
          repositoryRoles: repositoryRoleMappings(evidence.session.repositoryAttribution === "launch" ? evidence.session.cwd : ""),
          repository, pullRequests,
          usageLimits: createEmptyUsageLimits(), resources: historical ? null : unavailableResourceUsage(),
        }),
        readiness: createSessionReadiness("loading", { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready" }),
      };
    } catch {
      return {
        ...createEmptyMonitorState({ connected: true, source: provider.source, view: historical ? "history" : "live" }),
        readiness: createSessionReadiness("loading"),
      };
    }
  };
}
