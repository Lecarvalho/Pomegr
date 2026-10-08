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

const CATALOG_TITLE_LENGTH = 160;
const UNTITLED_SESSION = "Untitled session";

// The catalog cleans a title the same way: control characters become spaces, then trim and clip. Its own
// placeholder for a session that has no title yet is no title, so a card keeps showing the task text.
function sessionTitle(value) {
  const title = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, CATALOG_TITLE_LENGTH) : "";
  return title !== "" && title !== UNTITLED_SESSION ? title : null;
}

/**
 * A linked session's borrowed facts, from committed memory only: the catalog row (its title and the
 * `activityStatus` the Sessions list State column renders), then the observation store's committed public
 * state (a title the row lacks, and the primary agent's latest reported model). `null` when neither holds
 * the session. `fillTaskSessions` validates every field. No provider, Git, or new evidence read.
 */
export function resolveTaskSessionFacts(sessionRef, { observationStore, catalogSessions }) {
  const parsed = parseProviderSessionId(sessionRef);
  if (!parsed) return null;
  const entry = (catalogSessions() || []).find((row) => row?.id === sessionRef);
  const committed = observationStore.get(parsed.providerId, parsed.localSessionId)?.publicState;
  if (!entry && !committed) return null;
  const primary = Array.isArray(committed?.agents) ? committed.agents.find((agent) => agent?.id === "primary") : null;
  return {
    title: sessionTitle(entry?.title) ?? sessionTitle(committed?.session?.title),
    state: entry?.activityStatus ?? "unknown",
    observedModel: typeof primary?.model === "string" ? primary.model : null,
  };
}
