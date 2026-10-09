import { createTaskGateFacts, createTaskTreeObservation } from "./task-gate-facts.mjs";
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
 * `resolveTaskGateFacts(repositoryId)` returns the start-gate facts `{ usage, providerStatus, treeClean }` from the
 * committed usage response (`gateSources.usageLimits()`), the committed public provider status
 * (`gateSources.providerStatus()`), and the working-tree observation of the recognized root, which refreshes off the
 * request path (task-gate-facts.mjs). Without `gateSources` every fact but the tree is unknown.
 * No provider acquisition and no synchronous Git call happen here.
 */
export function createTaskLookups({ observationStore, catalogSessions, repositoryInventory, runModels = null, gateSources = null }) {
  const tree = createTaskTreeObservation({
    repositoryRoot: (repositoryId) => repositoryInventory.repositoryRoot?.(repositoryId) ?? null,
    ...(gateSources?.gitReader ? { gitReader: gateSources.gitReader } : {}),
    ...(gateSources?.forbiddenRoots ? { forbiddenRoots: gateSources.forbiddenRoots } : {}),
    ...(gateSources?.now ? { now: gateSources.now } : {}),
  });
  return {
    resolveTaskGateFacts: createTaskGateFacts({
      usageLimits: gateSources?.usageLimits, providerStatus: gateSources?.providerStatus, tree, ...(gateSources?.now ? { now: gateSources.now } : {}),
    }),
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
