import { createHash } from "node:crypto";
import path from "node:path";
import { memoizeRepositoryResolver, resolveSessionIdentity } from "../../normalize/session-identity.mjs";

/**
 * Bounded per-session repository-mutation bookkeeping, plus the codex-specific
 * wiring for the shared, provider-neutral `resolveSessionIdentity` rule. A session
 * accumulates proven mutation roots (from bound file-change evidence) permanently:
 * `provenRepositories` exposes them (bounded to the two distinct roots needed to
 * prove ambiguity) as the cheap, no-hydration input to that rule. `get`/`set` cache
 * the rule's own resolved identity for other monitor-private consumers (live
 * repository enrichment, role mappings) keyed by normalized session ID. Both maps
 * are bounded LRUs so a long-running monitor cannot grow this state without limit.
 */
export function createCodexRepositoryAttributionTracker() {
  const attributions = new Map();
  const bindingRoots = new Map();

  function remember(localSessionId, bindings) {
    const roots = bindingRoots.get(localSessionId) || new Map();
    if (bindings?.size) {
      for (const [repositoryId, binding] of bindings) {
        if (roots.size >= 2 && !roots.has(repositoryId)) break; // Two proven roots permanently establish ambiguity.
        roots.set(repositoryId, binding);
      }
      bindingRoots.delete(localSessionId);
      bindingRoots.set(localSessionId, roots);
      while (bindingRoots.size > 128) bindingRoots.delete(bindingRoots.keys().next().value);
    }
    return roots;
  }

  /** The bounded proven-mutation roots already known for this session, without
   * hydrating or parsing anything new: safe to read at catalog-header time. */
  function provenRepositories(localSessionId) {
    return bindingRoots.get(localSessionId) || new Map();
  }

  function get(localSessionId) {
    return attributions.get(localSessionId) || { state: "unknown" };
  }

  /** Update an attribution in place, keeping its recency position. */
  function set(localSessionId, attribution) {
    attributions.delete(localSessionId);
    attributions.set(localSessionId, attribution);
    while (attributions.size > 128) attributions.delete(attributions.keys().next().value);
  }

  /**
   * Resolve one session's identity through the shared rule and cache it for
   * `get()`. `bindings` (when given) are freshly proven mutation roots from this
   * read, merged permanently before resolving; omit it for a no-hydration,
   * catalog-header-time call that only consumes already-known proof.
   * @param {string} localSessionId
   * @param {{ launchCwd?: string|null, recordedBranch?: string|null, resolveRepository?: ((cwd: string, options?: { requireGit?: boolean }) => Promise<{ repositoryId: string, root: string } | null> | { repositoryId: string, root: string } | null) | null, bindings?: Map<string, { repositoryId: string, root: string }> }} [options]
   */
  async function resolveIdentity(localSessionId, { launchCwd, recordedBranch, resolveRepository, bindings } = {}) {
    if (bindings) remember(localSessionId, bindings);
    // A full read waits longer than a header row: its answer replaces the cached
    // attribution, so a transient slow lookup should not demote it (the previous
    // full-read path awaited the resolver without a bound).
    const identity = await resolveSessionIdentity({
      launchCwd, recordedBranch, resolveRepository,
      provenRepositories: provenRepositories(localSessionId),
      resolverTimeoutMs: 5_000,
    });
    set(localSessionId, identity.state === "single"
      ? {
        state: "single", repositoryId: identity.repositoryId, root: identity.root,
        fingerprint: createHash("sha256").update(identity.root).digest("hex").slice(0, 32),
        recordedBranch: identity.recordedBranch || null,
      }
      : { state: identity.state });
    return identity;
  }

  let headerResolverSource = null;
  let headerResolver = null;

  /**
   * Catalog-header identity: never hydrates and never writes the cache a full read
   * owns. A single or multiple attribution a full read established is reused as is;
   * otherwise the launch directory resolves through a memoized resolver, so rows
   * sharing a launch directory cost one lookup per minute and a slow lookup warms
   * the next poll instead of blocking this one.
   * @param {string} localSessionId
   * @param {{ launchCwd?: string|null, resolveRepository?: ((cwd: string, options?: { requireGit?: boolean }) => unknown) | null }} [options]
   * @returns {Promise<{ state: string, repositoryId: string|null, project: string }>}
   */
  async function headerIdentity(localSessionId, { launchCwd, resolveRepository } = {}) {
    const known = attributions.get(localSessionId);
    if (known?.state === "single") return { state: "single", repositoryId: known.repositoryId, project: path.basename(known.root) || "Repository" };
    if (known?.state === "multiple") return { state: "multiple", repositoryId: null, project: "Multiple repositories" };
    if (typeof resolveRepository !== "function") headerResolverSource = headerResolver = null;
    else if (resolveRepository !== headerResolverSource) {
      headerResolverSource = resolveRepository;
      headerResolver = memoizeRepositoryResolver(resolveRepository);
    }
    const identity = await resolveSessionIdentity({
      launchCwd, resolveRepository: /** @type {any} */ (headerResolver),
      provenRepositories: provenRepositories(localSessionId),
    });
    return { state: identity.state, repositoryId: identity.repositoryId, project: identity.project };
  }

  return { remember, provenRepositories, get, set, resolveIdentity, headerIdentity };
}
