import { parseProviderSessionId } from "../providers/provider-contract.mjs";
import { pullRequestCheckRead } from "../repository/pull-requests.mjs";

function selectPullRequest(selected, pulls, taskId) {
  if (pulls?.status !== "ready" || !Array.isArray(pulls.items)) return selected;
  const taskBranch = `tasks/${taskId}`;
  for (const item of pulls.items) {
    const taskMatch = item.headBranch === taskBranch;
    if (!taskMatch && item.association !== "session") continue;
    if (!selected || (taskMatch && selected.headBranch !== taskBranch)
      || (taskMatch === (selected.headBranch === taskBranch) && item.number > selected.number)) selected = item;
  }
  return selected;
}

export function resolveTaskPullRequestFacts(sessionId, taskId, { observationStore, checkRead = pullRequestCheckRead }) {
  const parsed = parseProviderSessionId(sessionId);
  const pulls = parsed ? observationStore.get(parsed.providerId, parsed.localSessionId)?.publicState?.session?.pullRequests : null;
  const selected = selectPullRequest(null, pulls, taskId);
  const committed = pulls?.checkReads?.find((read) => read?.url === selected?.url);
  // Normalized items omit the head; the response-bound check read retains that PR's head instead.
  const head = selected?.headOid ?? committed?.headOid;
  const headOid = typeof head === "string" && /^[a-f0-9]{40}$/iu.test(head) ? head.toLowerCase() : null;
  const read = Array.isArray(pulls?.checkReads) ? committed : selected ? checkRead(selected.url) : null;
  const checks = headOid && typeof read?.headOid === "string" && read.headOid.toLowerCase() === headOid
    && ["passed", "failed"].includes(read.status) ? read.status : null;
  return {
    number: selected?.number ?? null, state: selected?.state ?? null, headOid, checks,
    headBranch: selected?.headBranch || null, baseBranch: selected?.baseBranch || null, sameRepository: committed?.crossRepository === false,
  };
}

// Only retained, committed facts cross into the task control plane.
export function resolveTaskOutcomeFacts(sessionIds, sinceMs, taskId, { observationStore, repositoryRecordForSession }) {
  let ownerTurns = null;
  let commits = null;
  let selected = null;
  for (const sessionId of sessionIds) {
    const parsed = parseProviderSessionId(sessionId);
    if (!parsed) continue;
    const entry = observationStore.get(parsed.providerId, parsed.localSessionId);
    const messages = entry?.evidence?.userMessageTimes;
    if (Array.isArray(messages)) ownerTurns = (ownerTurns ?? 0) + messages.filter((time) => Date.parse(time) > sinceMs).length;
    const times = repositoryRecordForSession?.(sessionId)?.commitTimes;
    if (Array.isArray(times)) commits = (commits ?? 0) + times.filter((time) => Date.parse(time) > sinceMs).length;
    selected = selectPullRequest(selected, entry?.publicState?.session?.pullRequests, taskId);
  }
  return {
    owner_turns: ownerTurns,
    commits_after_review: commits,
    pull_request: selected?.number ?? null,
    pull_request_state: selected?.state ?? null,
  };
}
