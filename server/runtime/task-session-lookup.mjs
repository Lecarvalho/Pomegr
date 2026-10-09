import { parseProviderSessionId } from "../providers/provider-contract.mjs";
import { pullRequestCheckStatus } from "../repository/pull-requests.mjs";

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

const PULL_REQUEST_STATES = ["open", "merged", "closed"];

// CI passed judges the task branch's open pull requests, or its merged ones when none is open; a closed one
// never counts. No such pull request is a known "not passed"; one whose check status the monitor has not read
// is unknown. Only `passed` passes: pending, failed, and no check at all do not.
function ciPassed(items, checkStatus) {
  const judged = ["open", "merged"].map((state) => items.filter((item) => item.state === state)).find((list) => list.length > 0);
  if (!judged) return false;
  const statuses = judged.map((item) => checkStatus(item.url));
  return statuses.includes(null) ? null : statuses.every((status) => status === "passed");
}

/**
 * The repository facts the done-when checks judge for the bound session, from the session's committed public
 * state in memory only: `{ treeClean, branchCommits, pullRequestStates, ciPassed }`. The task branch is the branch
 * recorded for the session. Every fact that the committed state does not establish is null (unknown), which the
 * rule never passes: an unavailable or historical repository block, a branch with no base comparison, and a
 * pull-request block that is not ready. `ciPassed` joins those pull requests with the check status the monitor
 * last read for each (`pullRequestCheckStatus`, monitor-private memory). No Git, GitHub, or provider read.
 */
export function resolveTaskCheckFacts(sessionRef, { observationStore, checkStatus = pullRequestCheckStatus }) {
  const unknown = { treeClean: null, branchCommits: null, pullRequestStates: null, ciPassed: null };
  const parsed = parseProviderSessionId(sessionRef);
  if (!parsed) return unknown;
  const session = observationStore.get(parsed.providerId, parsed.localSessionId)?.publicState?.session;
  const repository = session?.repository;
  if (!repository || repository.available !== true || repository.historical === true || typeof repository.branch !== "string" || repository.branch === "") return unknown;
  const comparison = repository.comparison;
  const branchCommits = repository.isMain === true ? false
    : comparison?.kind === "base" && Number.isSafeInteger(comparison.ahead) ? comparison.ahead > 0 || comparison.integrated === true : null;
  const pulls = session.pullRequests;
  const branchPulls = pulls?.status === "ready" && Array.isArray(pulls.items)
    ? pulls.items.filter((item) => item?.headBranch === repository.branch && PULL_REQUEST_STATES.includes(item.state))
    : null;
  return {
    treeClean: Array.isArray(repository.files) ? repository.files.length === 0 : null,
    branchCommits,
    pullRequestStates: branchPulls ? branchPulls.map((item) => item.state) : null,
    ciPassed: branchPulls ? ciPassed(branchPulls, checkStatus) : null,
  };
}
