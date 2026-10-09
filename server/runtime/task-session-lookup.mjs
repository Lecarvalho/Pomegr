import { parseProviderSessionId } from "../providers/provider-contract.mjs";

/**
 * The bound session's recognized repository identity for the agent task write, from committed facts
 * only: the observation store's public state, then the committed catalog row. No provider or Git read.
 */
export function resolveTaskSession(sessionRef, { observationStore, catalogSessions }) {
  const parsed = parseProviderSessionId(sessionRef);
  if (!parsed) return null;
  const committed = observationStore.get(parsed.providerId, parsed.localSessionId)?.publicState?.session;
  const entry = (catalogSessions() || []).find((row) => row?.id === sessionRef);
  if (!committed && !entry) return null;
  return { found: true, repositoryId: committed?.repositoryId ?? entry?.repositoryId ?? null };
}
