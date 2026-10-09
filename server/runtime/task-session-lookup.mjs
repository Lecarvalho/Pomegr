import { parseProviderSessionId } from "../providers/provider-contract.mjs";
import { pullRequestCheckRead } from "../repository/pull-requests.mjs";

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
 * the session. `writerReleased` is true when the primary agent's committed liveness says the Codex writer was
 * released; with an Unknown state it establishes that the session ended (`sessionEnded` in task-stall.mjs).
 * `fillTaskSessions` validates every field it serves. No provider, Git, or new evidence read.
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
    writerReleased: primary?.liveness?.reason === "writer_released",
  };
}

const PULL_REQUEST_STATES = ["open", "merged", "closed"];

// CI passed judges the task branch's open pull requests, or its merged ones when none is open; a closed one
// never counts. No such pull request is a known "not passed"; one whose check status the monitor has not read
// is unknown. Only `passed` passes: pending, failed, and no check at all do not. The read time is the oldest
// among the judged pull requests, and null when the value does not rest on a read.
function ciPassed(items, checkRead) {
  const judged = ["open", "merged"].map((state) => items.filter((item) => item.state === state)).find((list) => list.length > 0);
  if (!judged) return { value: false, readAt: null };
  const reads = judged.map((item) => checkRead(item.url));
  if (reads.some((read) => !read || !Number.isFinite(read.readAt))) return { value: null, readAt: null };
  return { value: reads.every((read) => read.status === "passed"), readAt: Math.min(...reads.map((read) => read.readAt)) };
}

// Epoch milliseconds of an ISO timestamp, or null when the value is not one.
function timeOf(value) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

// Work whose end moves the time a fact must be read after. Git, push, and pull-request commands change the
// branch comparison and the pull requests; any shell command can change the working tree.
const REPOSITORY_WORK_KINDS = new Set(["git", "git_push", "pull_request"]);

// The latest time of work in the session's committed public state that could have changed a repository fact:
// `tree` (recorded file changes and any finished shell command) and `repository` (finished Git, push, and pull-request
// commands). Null means no such work is recorded. A command still running, or finished at no known time, is
// `Infinity`: the work is not over, so no fact read so far can be later than it. Bounded feeds count too: when the
// activity feed is truncated and shows no file change, the newest change is at or before its oldest item.
function workTimes(state) {
  const tasks = [...(Array.isArray(state?.executionTasks) ? state.executionTasks : []),
    ...(Array.isArray(state?.agents) ? state.agents : []).flatMap((agent) => (Array.isArray(agent?.executionTasks) ? agent.executionTasks : []))];
  const latest = (times) => (times.length === 0 ? null : Math.max(...times));
  const endOf = (task) => (task?.status === "running" ? Number.POSITIVE_INFINITY : timeOf(task?.finishedAt) ?? Number.POSITIVE_INFINITY);
  const ends = tasks.filter((task) => task && typeof task === "object").map((task) => ({ kind: task.workKind, end: endOf(task) }));
  const items = Array.isArray(state?.activity?.items) ? state.activity.items : [];
  const writes = items.filter((item) => item?.workKind === "write").map((item) => timeOf(item.timestamp) ?? Number.POSITIVE_INFINITY);
  const oldest = items.map((item) => timeOf(item?.timestamp)).filter((time) => time !== null);
  const truncated = Number.isSafeInteger(state?.activity?.total) && state.activity.total > items.length;
  if (truncated && writes.length === 0) writes.push(oldest.length > 0 ? Math.min(...oldest) : Number.POSITIVE_INFINITY);
  return {
    tree: latest([...ends.map((task) => task.end), ...writes]),
    repository: latest(ends.filter((task) => REPOSITORY_WORK_KINDS.has(task.kind)).map((task) => task.end)),
  };
}

/**
 * The repository facts the done-when checks judge for the bound session, from the session's committed public
 * state in memory only: `{ treeClean, branchCommits, pullRequestStates, ciPassed, readAt, workAt }`. The task branch
 * is the branch recorded for the session. Every fact that the committed state does not establish is null (unknown),
 * which the rule never passes: an unavailable or historical repository block, a branch with no base comparison, and a
 * pull-request block that is not ready. `ciPassed` joins those pull requests with the check status the monitor
 * last read for each (`pullRequestCheckRead`, monitor-private memory). No Git, GitHub, or provider read.
 *
 * Each fact carries the time it was read (`readAt`, epoch milliseconds or null) and the latest work that could have
 * changed it (`workAt`, see `workTimes`), so the rule can refuse a fact older than the work it judges:
 * - `readAt.pullRequests` is the pull-request block's own check time.
 * - `readAt.branch` is the time the committed remote comparison was refreshed (`repository.remote.checkedAt`), or the
 *   repository block's own `readAt` when it carries one; the comparison was computed at or after it.
 * - `readAt.tree` is the repository block's own `readAt` and nothing else: the committed working-tree files carry no
 *   read time of their own, so until the repository producer stamps one the tree fact is unknown.
 * - `readAt.ci` is the oldest read among the judged pull requests' check statuses.
 * Nothing here reads the request clock.
 */
export function resolveTaskCheckFacts(sessionRef, { observationStore, checkRead = pullRequestCheckRead }) {
  const unknown = { treeClean: null, branchCommits: null, pullRequestStates: null, ciPassed: null,
    readAt: { tree: null, branch: null, pullRequests: null, ci: null }, workAt: { tree: null, repository: null } };
  const parsed = parseProviderSessionId(sessionRef);
  if (!parsed) return unknown;
  const state = observationStore.get(parsed.providerId, parsed.localSessionId)?.publicState;
  const session = state?.session;
  const repository = session?.repository;
  if (!repository || repository.available !== true || repository.historical === true || typeof repository.branch !== "string" || repository.branch === "") return unknown;
  const comparison = repository.comparison;
  const branchCommits = repository.isMain === true ? false
    : comparison?.kind === "base" && Number.isSafeInteger(comparison.ahead) ? comparison.ahead > 0 || comparison.integrated === true : null;
  const pulls = session.pullRequests;
  const branchPulls = pulls?.status === "ready" && Array.isArray(pulls.items)
    ? pulls.items.filter((item) => item?.headBranch === repository.branch && PULL_REQUEST_STATES.includes(item.state))
    : null;
  const ci = branchPulls ? ciPassed(branchPulls, checkRead) : { value: null, readAt: null };
  const blockReadAt = timeOf(repository.readAt);
  const comparisonReadAt = repository.remote?.status === "ready" ? timeOf(repository.remote.checkedAt) : null;
  const branchReads = [blockReadAt, comparisonReadAt].filter((time) => time !== null);
  return {
    treeClean: Array.isArray(repository.files) ? repository.files.length === 0 : null,
    branchCommits,
    pullRequestStates: branchPulls ? branchPulls.map((item) => item.state) : null,
    ciPassed: ci.value,
    readAt: {
      tree: blockReadAt,
      branch: branchReads.length > 0 ? Math.max(...branchReads) : null,
      pullRequests: timeOf(pulls?.checkedAt),
      ci: ci.readAt,
    },
    workAt: workTimes(state),
  };
}
