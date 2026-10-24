import { parseProviderSessionId } from "../providers/provider-contract.mjs";

// Only retained, committed facts cross into the task control plane.
export function resolveTaskOutcomeFacts(sessionIds, sinceMs, taskId, { observationStore, repositoryRecordForSession }) {
  let ownerTurns = null;
  let commits = null;
  let selected = null;
  const taskBranch = `tasks/${taskId}`;
  for (const sessionId of sessionIds) {
    const parsed = parseProviderSessionId(sessionId);
    if (!parsed) continue;
    const entry = observationStore.get(parsed.providerId, parsed.localSessionId);
    const messages = entry?.evidence?.userMessageTimes;
    if (Array.isArray(messages)) ownerTurns = (ownerTurns ?? 0) + messages.filter((time) => Date.parse(time) > sinceMs).length;
    const times = repositoryRecordForSession?.(sessionId)?.commitTimes;
    if (Array.isArray(times)) commits = (commits ?? 0) + times.filter((time) => Date.parse(time) > sinceMs).length;
    const pulls = entry?.publicState?.session?.pullRequests;
    if (pulls?.status !== "ready" || !Array.isArray(pulls.items)) continue;
    for (const item of pulls.items) {
      const taskMatch = item.headBranch === taskBranch;
      if (!taskMatch && item.association !== "session") continue;
      if (!selected || (taskMatch && selected.headBranch !== taskBranch)
        || (taskMatch === (selected.headBranch === taskBranch) && item.number > selected.number)) selected = item;
    }
  }
  return {
    owner_turns: ownerTurns,
    commits_after_review: commits,
    pull_request: selected?.number ?? null,
    pull_request_state: selected?.state ?? null,
  };
}
