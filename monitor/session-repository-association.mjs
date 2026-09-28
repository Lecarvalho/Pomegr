/** Background-only association cache; stale completions cannot restore an old root. */
export function createSessionRepositoryAssociations({ registry, inventory, previousReference, onChange }) {
  const associations = new Map();
  const pending = new Map();
  function retain(id, key, value) {
    associations.set(id, { key, value });
    while (associations.size > 128) associations.delete(associations.keys().next().value);
  }
  return {
    get(candidate) {
      const id = `${candidate.providerId}:${candidate.localSessionId}`;
      const session = candidate.evidence.session;
      const attribution = registry.repositoryAttributionForSession?.(id);
      const cwd = attribution ? attribution.state === "single" ? attribution.root : null : session.cwd;
      const key = JSON.stringify([cwd, attribution?.state, session.repositoryAttribution]);
      const cached = associations.get(id);
      if (cached?.key === key) return cached.value;
      if (pending.get(id)?.key === key) return null;
      const operation = { key };
      pending.set(id, operation);
      const unavailable = session.repositoryAttribution && !["single", "recorded", "launch"].includes(session.repositoryAttribution);
      if (!cwd || unavailable) {
        retain(id, key, null);
        pending.delete(id);
        return null;
      }
      void Promise.resolve().then(() => inventory.associateSession({
        sessionId: id, provider: candidate.providerId, startedAt: session.startedAt, cwd,
        previousReference: previousReference(candidate),
      })).then(
        (association) => { if (pending.get(id) === operation) retain(id, key, association || null); },
        () => { if (pending.get(id) === operation) retain(id, key, null); },
      ).finally(() => {
        if (pending.get(id) !== operation) return;
        pending.delete(id);
        onChange(id);
      });
      return null;
    },
    clear() { associations.clear(); pending.clear(); },
  };
}
