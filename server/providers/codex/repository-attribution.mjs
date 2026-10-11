import { createHash } from "node:crypto";
import path from "node:path";
import { memoizeRepositoryResolver, resolveSessionIdentity } from "../../normalize/session-identity.mjs";

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

  // The bounded proven-mutation roots already known for this session, without
  // hydrating or parsing anything new: safe to read at catalog-header time.
  function provenRepositories(localSessionId) {
    return bindingRoots.get(localSessionId) || new Map();
  }

  function get(localSessionId) {
    return attributions.get(localSessionId) || { state: "unknown" };
  }

  function set(localSessionId, attribution) {
    attributions.delete(localSessionId);
    attributions.set(localSessionId, attribution);
    while (attributions.size > 128) attributions.delete(attributions.keys().next().value);
  }

  /**
   * @param {string} localSessionId
   * @param {{ launchCwd?: string|null, recordedBranch?: string|null, resolveRepository?: ((cwd: string, options?: { requireGit?: boolean }) => Promise<{ repositoryId: string, root: string } | null> | { repositoryId: string, root: string } | null) | null, bindings?: Map<string, { repositoryId: string, root: string }> }} [options]
   */
  async function resolveIdentity(localSessionId, { launchCwd, recordedBranch, resolveRepository, bindings } = {}) {
    if (bindings) remember(localSessionId, bindings);
    const identity = await resolveSessionIdentity({
      launchCwd, recordedBranch, resolveRepository,
      provenRepositories: provenRepositories(localSessionId),
      resolverTimeoutMs: 5_000,
    });
    set(localSessionId, identity.state === "single"
      ? {
        state: "single", repositoryId: identity.repositoryId, root: identity.root, project: identity.project,
        fingerprint: createHash("sha256").update(identity.root).digest("hex").slice(0, 32),
        recordedBranch: identity.recordedBranch || null,
      }
      : { state: identity.state });
    return identity;
  }

  let headerResolverSource = null;
  let headerResolver = null;

  /**
   * @param {string} localSessionId
   * @param {{ launchCwd?: string|null, resolveRepository?: ((cwd: string, options?: { requireGit?: boolean }) => unknown) | null }} [options]
   * @returns {Promise<{ state: string, repositoryId: string|null, project: string }>}
   */
  async function headerIdentity(localSessionId, { launchCwd, resolveRepository } = {}) {
    const known = attributions.get(localSessionId);
    if (known?.state === "single") return { state: "single", repositoryId: known.repositoryId, project: known.project || path.basename(known.root) || "Repository" };
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
