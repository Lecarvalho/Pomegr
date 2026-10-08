import fs from "node:fs";
import path from "node:path";

/**
 * Build the adapter-private mapping from a Claude source notification to its root session.
 * When `options.ledger` is supplied, a notification for a top-level main transcript is also
 * noticed in the shared source ledger, mirroring Codex's `noticeCodexRolloutSource`: the
 * candidate must carry a `.jsonl` extension and its realpath must resolve inside the
 * projects root before it reaches the ledger (a rejected extension, an escaping realpath
 * from a symlink/junction, or a path outside the root never reaches it). This is a filter
 * only, not a second notion of "main transcript"; it reuses the same `isMainTranscript`
 * result the routing decision below already computes. The projects root's own realpath is
 * cached once resolved; a failed resolution is retried on the next notification. The ledger
 * receives the notified path itself, in the configured-root form discovery also uses.
 * @param {string} projectsRoot
 * @param {{registryRoot?: string, liveSessionIds?: () => string[], ledger?: object, fs?: {realpath: Function}}} [options]
 */
export function createClaudeSourceEventRouter(projectsRoot, options = {}) {
  const directoryKey = (value) => typeof value === "string"
    ? (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)) : null;
  const registryKey = directoryKey(options.registryRoot);
  const ledger = options.ledger || null;
  const operations = options.fs || fs.promises;
  let projectsRootRealpath;
  async function resolvedProjectsRoot() {
    if (projectsRootRealpath) return projectsRootRealpath;
    try { projectsRootRealpath = await operations.realpath(projectsRoot); } catch { return null; }
    return projectsRootRealpath;
  }
  /** Resolve a candidate main-transcript path through the same filter Codex's
   * `trustedRolloutPath` applies: a `.jsonl` name and realpath containment in the projects
   * root. Returns true when the candidate is trusted. Reads no transcript content. */
  async function trustedMainTranscriptPath(candidate) {
    if (path.extname(candidate).toLowerCase() !== ".jsonl") return false;
    const root = await resolvedProjectsRoot();
    if (!root) return false;
    let real;
    try { real = await operations.realpath(candidate); } catch { return false; }
    const relative = path.relative(root, real);
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  /** @param {{target?: string, candidate?: string | null, eventType?: string, knownSessionIds?: string[]}} [change] */
  return async function routeClaudeSourceEvent({ target, candidate, eventType, knownSessionIds = [] } = {}) {
    if (registryKey && directoryKey(target) === registryKey) return {
      catalog: true, afterCatalog: true, sessionIds: (options.liveSessionIds?.() || []).slice(0, 50),
    };
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
    if (ledger && isMainTranscript) {
      if (await trustedMainTranscriptPath(candidate)) ledger.noticeSource(candidate);
    }
    return {
      catalog: eventType === "rename" || isMainTranscript || sessionIds.length === 0,
      sessionIds,
      sourceKnown: knownSessionIds.length > 0,
    };
  };
}
