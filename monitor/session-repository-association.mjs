/** Background-only association cache; stale completions cannot restore an old root. */
export function createSessionRepositoryAssociations({ registry, inventory, previousReference, previousAssociation, onChange }) {
  const associations = new Map();
  const pending = new Map();
  // Keys outlive the bounded value cache: a committed association is reused only for its own key.
  const settledKeys = new Map();
  function retain(id, key, value) {
    associations.set(id, { key, value });
    while (associations.size > 128) associations.delete(associations.keys().next().value);
    settledKeys.delete(id); settledKeys.set(id, key);
    while (settledKeys.size > 4096) settledKeys.delete(settledKeys.keys().next().value);
  }
  const fingerprint = (value) => JSON.stringify(value ? [value.repositoryId ?? null, value.contextInventoryRef ?? null] : null);
  return {
    get(candidate) {
      const id = `${candidate.providerId}:${candidate.localSessionId}`;
      const session = candidate.evidence.session;
      const attribution = registry.repositoryAttributionForSession?.(id);
      const cwd = attribution ? attribution.state === "single" ? attribution.root : null : session.cwd;
      const key = JSON.stringify([cwd, attribution?.state, session.repositoryAttribution]);
      const cached = associations.get(id);
      if (cached?.key === key) return cached.value;
      const committed = () => settledKeys.get(id) === key ? previousAssociation?.(candidate) || null : null;
      if (pending.get(id)?.key === key) return committed();
      // The bounded cache holds fewer sessions than the store. A miss serves the
      // committed association so re-derivation cannot flip it to null, and the
      // settled lookup rederives only when it actually changes the value served.
      const operation = { key, value: null };
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
        (association) => { if (pending.get(id) === operation) { operation.value = association || null; retain(id, key, operation.value); } },
        () => { if (pending.get(id) === operation) retain(id, key, null); },
      ).finally(() => {
        if (pending.get(id) !== operation) return;
        pending.delete(id);
        if (operation.value && fingerprint(operation.value) !== fingerprint(committed())) onChange(id);
      });
      return committed();
    },
    clear() { associations.clear(); pending.clear(); settledKeys.clear(); },
  };
}
