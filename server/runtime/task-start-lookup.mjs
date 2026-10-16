import { createTaskGateFacts, createTaskTreeObservation } from "./task-gate-facts.mjs";
import { readTaskCheckFacts, resolveTaskCheckFacts, resolveTaskSession, resolveTaskSessionFacts } from "./task-session-lookup.mjs";
import { createTaskIssues } from "./task-issues.mjs";
import { comparePluginVersions } from "../../shared/repository-plugin-state.mjs";

export const MINIMUM_TASK_PLUGIN_VERSION = "0.9.0";

// Committed-fact lookups for the task control plane.
export function createTaskLookups({ observationStore, catalogSessions, repositoryInventory, runModels = null, gateSources = null, issueReader = undefined, readRepositoryNow = null }) {
  const tree = createTaskTreeObservation({
    repositoryRoot: (repositoryId) => repositoryInventory.repositoryRoot?.(repositoryId) ?? null,
    ...(gateSources?.gitReader ? { gitReader: gateSources.gitReader } : {}),
    ...(gateSources?.now ? { now: gateSources.now } : {}),
  });
  return {
    // GitHub issues for the task board: explicit desktop actions only, never a GET.
    taskIssues: createTaskIssues({ repositoryRoot: (repositoryId) => repositoryInventory.repositoryRoot?.(repositoryId) ?? null, reader: issueReader }),
    resolveTaskGateFacts: createTaskGateFacts({
      usageLimits: gateSources?.usageLimits, providerStatus: gateSources?.providerStatus, tree, ...(gateSources?.now ? { now: gateSources.now } : {}),
    }),
    resolveTaskSession: (sessionRef) => resolveTaskSession(sessionRef, { observationStore, catalogSessions }),
    resolveTaskSessionFacts: (sessionRef) => resolveTaskSessionFacts(sessionRef, { observationStore, catalogSessions }),
    resolveTaskCheckFacts: (sessionRef) => resolveTaskCheckFacts(sessionRef, { observationStore }),
    readTaskCheckFacts: (sessionRef) => readTaskCheckFacts(sessionRef, { observationStore, readNow: readRepositoryNow }),
    resolveRunModels: () => runModels?.codex?.() ?? [],
    resolveTaskStart(repositoryId, provider = "claude") {
      const root = repositoryInventory.repositoryRoot?.(repositoryId) ?? null;
      const setup = repositoryInventory.readPluginSetup?.(repositoryId, provider === "codex" ? "codex" : "claude");
      const comparison = comparePluginVersions(setup?.version, MINIMUM_TASK_PLUGIN_VERSION);
      const pluginReady = setup?.readiness === "ready" && setup.installation === "installed" && setup.enabled !== false
        && comparison !== null && comparison >= 0;
      return { root, pluginReady };
    },
  };
}
