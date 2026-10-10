/** Background-only association cache; stale completions cannot restore an old root. */
export function createSessionRepositoryAssociations({ registry, inventory, previousReference, previousAssociation, onChange }) {
  const associations = new Map();
  const pending = new Map();
  // Keys outlive the bounded value cache: a committed association is reused only for its own key.
  const settledKeys = new Map();
  // Sessions settled on a provisional identity (a removed task worktree whose repository was not known
  // yet), with their private launch directory. Any later lookup asks for their projection again once the
  // repository is known, so the provisional identity does not outlive that moment. Memory only.
  const awaitingOwner = new Map();
  const cwdOf = (key) => JSON.parse(key)[0];
  function refreshKnownOwners() {
    for (const [id, cwd] of awaitingOwner) {
      if (inventory.taskWorktreeOwner?.(cwd) !== "known") continue;
      awaitingOwner.delete(id);
      queueMicrotask(() => { try { onChange(id); } catch { /* isolated */ } });
    }
  }
  function retain(id, key, value, provisional = false) {
    associations.set(id, { key, value, provisional });
    if (provisional) awaitingOwner.set(id, cwdOf(key)); else awaitingOwner.delete(id);
    while (awaitingOwner.size > 128) awaitingOwner.delete(awaitingOwner.keys().next().value);
    while (associations.size > 128) associations.delete(associations.keys().next().value);
    settledKeys.delete(id); settledKeys.set(id, key);
    while (settledKeys.size > 4096) settledKeys.delete(settledKeys.keys().next().value);
  }
  const fingerprint = (value) => JSON.stringify(value ? [value.repositoryId ?? null, value.contextInventoryRef ?? null] : null);
  return {
    get(candidate) {
      const id = `${candidate.providerId}:${candidate.localSessionId}`;
      if (awaitingOwner.size) refreshKnownOwners();
      const session = candidate.evidence.session;
      const attribution = registry.repositoryAttributionForSession?.(id);
      const cwd = attribution ? attribution.state === "single" ? attribution.root : null : session.cwd;
      const key = JSON.stringify([cwd, attribution?.state, session.repositoryAttribution]);
      const cached = associations.get(id);
      // A removed task worktree whose repository was not known yet settled on a provisional identity.
      // Once the repository is known it is derived again, and the settled value is served meanwhile.
      const stale = cached?.key === key && cached.provisional === true && inventory.taskWorktreeOwner?.(cwd) === "known";
      if (cached?.key === key && !stale) return cached.value;
      const committed = () => stale ? cached.value : settledKeys.get(id) === key ? previousAssociation?.(candidate) || null : null;
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
        (association) => { if (pending.get(id) === operation) { operation.value = association || null; retain(id, key, operation.value, inventory.taskWorktreeOwner?.(cwd) === "unknown"); } },
        () => { if (pending.get(id) === operation) retain(id, key, null); },
      ).finally(() => {
        if (pending.get(id) !== operation) return;
        pending.delete(id);
        if (operation.value && fingerprint(operation.value) !== fingerprint(committed())) onChange(id);
      });
      return committed();
    },
    clear() { associations.clear(); pending.clear(); settledKeys.clear(); awaitingOwner.clear(); },
  };
}
