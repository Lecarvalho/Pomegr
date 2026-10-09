import { resolveTaskSession } from "./task-session-lookup.mjs";

/**
 * Committed-fact lookups for the task control plane. `resolveTaskStart(repositoryId)` returns the recognized
 * repository root (monitor-private) and whether the committed plugin-setup observation proves the Pomegr
 * plugin for Claude Code is installed and enabled. An unknown or loading observation is never proof.
 * `resolveRunModels()` returns the last committed Codex client-catalog models `{ id, label }` for the task
 * panel's Run on list, from the catalog the release scheduler already committed in memory.
 * No provider acquisition and no Git call happen here.
 */
export function createTaskLookups({ observationStore, catalogSessions, repositoryInventory, runModels = null }) {
  return {
    resolveTaskSession: (sessionRef) => resolveTaskSession(sessionRef, { observationStore, catalogSessions }),
    resolveRunModels: () => runModels?.codex?.() ?? [],
    resolveTaskStart(repositoryId) {
      const root = repositoryInventory.repositoryRoot?.(repositoryId) ?? null;
      const setup = repositoryInventory.readPluginSetup?.(repositoryId, "claude");
      const pluginReady = setup?.readiness === "ready" && setup.installation === "installed" && setup.enabled !== false;
      return { root, pluginReady };
    },
  };
}
