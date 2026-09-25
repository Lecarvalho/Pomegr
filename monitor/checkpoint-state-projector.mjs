import { projectProviderSessionEvidence } from "./session-projection.mjs";
import { createSessionReadiness } from "./observation-readiness.mjs";
import { resolveCheckpointRepository } from "./repository-snapshot.mjs";

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
        recordedGitState, unavailableGitState, unavailablePullRequests,
      });
      return {
        ...projectProviderSessionEvidence({
          evidence, sessionId, source: provider.source, capabilities: provider.capabilities,
          repositoryRoles: repositoryRoleMappings(evidence.session.cwd), repository, pullRequests,
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
