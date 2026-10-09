import { resolveTaskCheckFacts, resolveTaskSession, resolveTaskSessionFacts } from "./task-session-lookup.mjs";

/**
 * Committed-fact lookups for the task control plane. `resolveTaskStart(repositoryId, provider)` returns the recognized
 * repository root (monitor-private) and whether the committed plugin-setup observation proves the Pomegr
 * plugin for that provider (`claude` or `codex`) is installed and enabled. An unknown or loading observation is never proof.
 * `resolveTaskSessionFacts(sessionRef)` returns `{ title, state, observedModel }` for a linked session from the
 * committed catalog row and public state, or null.
 * `resolveTaskCheckFacts(sessionRef)` returns the repository facts the done-when checks judge for a bound session,
 * from its committed public state, each null when unknown.
 * `resolveRunModels()` returns the last committed Codex client-catalog models `{ id, label }` for the task
 * panel's Run on list, from the catalog the release scheduler already committed in memory.
 * No provider acquisition and no Git call happen here.
 */
export function createTaskLookups({ observationStore, catalogSessions, repositoryInventory, runModels = null }) {
  return {
    resolveTaskSession: (sessionRef) => resolveTaskSession(sessionRef, { observationStore, catalogSessions }),
    resolveTaskSessionFacts: (sessionRef) => resolveTaskSessionFacts(sessionRef, { observationStore, catalogSessions }),
    resolveTaskCheckFacts: (sessionRef) => resolveTaskCheckFacts(sessionRef, { observationStore }),
    resolveRunModels: () => runModels?.codex?.() ?? [],
    resolveTaskStart(repositoryId, provider = "claude") {
      const root = repositoryInventory.repositoryRoot?.(repositoryId) ?? null;
      const setup = repositoryInventory.readPluginSetup?.(repositoryId, provider === "codex" ? "codex" : "claude");
      const pluginReady = setup?.readiness === "ready" && setup.installation === "installed" && setup.enabled !== false;
      return { root, pluginReady };
    },
  };
}
