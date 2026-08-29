import path from "node:path";

/** Build the adapter-private mapping from a Claude source notification to its root session. */
export function createClaudeSourceEventRouter(projectsRoot) {
  /** @param {{candidate?: string | null, eventType?: string, knownSessionIds?: string[]}} [change] */
  return function routeClaudeSourceEvent({ candidate, eventType, knownSessionIds = [] } = {}) {
    if (typeof candidate !== "string" || !candidate) return { catalog: true, sessionIds: [] };
    const relative = path.relative(projectsRoot, candidate);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { catalog: true, sessionIds: [] };
    }
    const segments = relative.split(path.sep).filter(Boolean);
    const subagentsAt = segments.lastIndexOf("subagents");
    const inferred = subagentsAt > 0
      ? segments[subagentsAt - 1]
      : path.extname(candidate).toLowerCase() === ".jsonl" ? path.basename(candidate, ".jsonl") : null;
    const sessionIds = knownSessionIds.length
      ? knownSessionIds
      : typeof inferred === "string" && inferred.length > 0 && inferred.length <= 512
        && !/[\\/\u0000-\u001f\u007f]/.test(inferred) ? [inferred] : [];
    const isMainTranscript = subagentsAt < 0 && path.extname(candidate).toLowerCase() === ".jsonl";
    return {
      catalog: eventType === "rename" || isMainTranscript || sessionIds.length === 0,
      sessionIds,
    };
  };
}
