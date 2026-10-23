import { parseProviderSessionId } from "../providers/provider-contract.mjs";
import { pullRequestCheckRead } from "../repository/pull-requests.mjs";

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

function sessionTitle(value) {
  const title = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, CATALOG_TITLE_LENGTH) : "";
  return title !== "" && title !== UNTITLED_SESSION ? title : null;
}

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
    observedEffort: typeof primary?.effort === "string" ? primary.effort : null,
    writerReleased: primary?.liveness?.reason === "writer_released",
  };
}

const PULL_REQUEST_STATES = ["open", "merged", "closed"];

function ciPassed(items, repository, pulls, checkRead) {
  const unknown = { value: null, readAt: null };
  if (!/^[a-f0-9]{40}$/iu.test(repository.headOid || "")) return unknown;
  const matching = items.filter((item) => item?.headBranch === repository.branch);
  const judged = ["open", "merged"].map((state) => matching.filter((item) => item?.state === state)).find((list) => list.length > 0);
  if (!judged) return unknown;
  const reads = judged.map((item) => Array.isArray(pulls.checkReads)
    ? pulls.checkReads.find((read) => read.url === item.url) : checkRead(item.url));
  if (reads.some((read) => !read || !Number.isFinite(read.readAt)
    || typeof read.headOid !== "string" || read.headOid.toLowerCase() !== repository.headOid.toLowerCase())) return unknown;
  const value = reads.some((read) => read.status === "failed") ? false
    : reads.every((read) => read.status === "passed") ? true : null;
  return { value, readAt: Math.min(...reads.map((read) => read.readAt)) };
}

// Epoch milliseconds of an ISO timestamp, or null when the value is not one.
function timeOf(value) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

// Work whose end moves the time a fact must be read after.
const REPOSITORY_WORK_KINDS = new Set(["git", "git_push", "pull_request"]);

function executionTasks(state) {
  return [...(Array.isArray(state?.executionTasks) ? state.executionTasks : []),
    ...(Array.isArray(state?.agents) ? state.agents : []).flatMap((agent) => (Array.isArray(agent?.executionTasks) ? agent.executionTasks : []))];
}

// Only unresolved work already under way when Git read the checkout may be the enclosing code cell.
function ciReadAfterKnownWork(state, readAt) {
  return readAt !== null && executionTasks(state).filter((task) => REPOSITORY_WORK_KINDS.has(task?.workKind)).every((task) => {
    const time = timeOf(task.status === "running" ? task.startedAt : task.finishedAt);
    return time !== null && time <= readAt;
  });
}

function workTimes(state) {
  const tasks = executionTasks(state);
  const latest = (times) => (times.length === 0 ? null : Math.max(...times));
  const endOf = (task) => (task?.status === "running" ? Number.POSITIVE_INFINITY : timeOf(task?.finishedAt) ?? Number.POSITIVE_INFINITY);
  const ends = tasks.filter((task) => task && typeof task === "object").map((task) => ({ kind: task.workKind, end: endOf(task) }));
  const items = Array.isArray(state?.activity?.items) ? state.activity.items : [];
  // A file write's item is dated by its call; the file changes when the call ends (`timestamp + durationMs`).
  const writeEnd = (item) => {
    const start = timeOf(item.timestamp);
    return start !== null && Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 ? start + item.durationMs : Number.POSITIVE_INFINITY;
  };
  const writes = items.filter((item) => item?.workKind === "write").map(writeEnd);
  const oldest = items.map((item) => timeOf(item?.timestamp)).filter((time) => time !== null);
  const truncated = Number.isSafeInteger(state?.activity?.total) && state.activity.total > items.length;
  if (truncated && writes.length === 0) writes.push(oldest.length > 0 ? Math.min(...oldest) : Number.POSITIVE_INFINITY);
  return {
    tree: latest([...ends.map((task) => task.end), ...writes]),
    repository: latest(ends.filter((task) => REPOSITORY_WORK_KINDS.has(task.kind)).map((task) => task.end)),
  };
}

function checkFacts(state, blocks, checkRead, freshCi = false) {
  const unknown = { treeClean: null, branchCommits: null, pullRequestStates: null, ciPassed: null,
    readAt: { tree: null, branch: null, pullRequests: null, ci: null }, workAt: { tree: null, repository: null } };
  const repository = blocks?.repository;
  if (!repository || repository.available !== true || repository.historical === true || typeof repository.branch !== "string" || repository.branch === "") return unknown;
  const comparison = repository.comparison;
  const branchCommits = repository.isMain === true ? false
    : comparison?.kind === "base" && Number.isSafeInteger(comparison.ahead) ? comparison.ahead > 0 || comparison.integrated === true : null;
  // The session's pull requests are the ones its pull-request block lists: those it created and those of its branch.
  const pulls = blocks.pullRequests;
  const branchPulls = pulls?.status === "ready" && Array.isArray(pulls.items) ? pulls.items : null;
  const ci = branchPulls ? ciPassed(branchPulls, repository, pulls, checkRead) : { value: null, readAt: null };
  const blockReadAt = timeOf(repository.readAt);
  const pullsReadAt = timeOf(pulls?.readAt);
  const comparisonReadAt = repository.remote?.status === "ready" ? blockReadAt : null;
  const ciRevisionVerified = freshCi && ci.value !== null && ciReadAfterKnownWork(state, blockReadAt);
  return {
    treeClean: Array.isArray(repository.files) ? repository.files.length === 0 : null,
    branchCommits,
    pullRequestStates: branchPulls ? branchPulls.map((item) => (PULL_REQUEST_STATES.includes(item?.state) ? item.state : "unknown")) : null,
    ciPassed: freshCi && !ciRevisionVerified ? null : ci.value,
    readAt: {
      tree: blockReadAt,
      branch: comparisonReadAt,
      pullRequests: pullsReadAt,
      ci: ci.readAt !== null && pullsReadAt !== null ? Math.min(ci.readAt, pullsReadAt) : null,
    },
    workAt: workTimes(state),
    // A report's own revision-bound read establishes CI even while its enclosing code cell is still running.
    ...(ciRevisionVerified ? { ciRevisionVerified: true } : {}),
  };
}

const committedState = (sessionRef, observationStore) => {
  const parsed = parseProviderSessionId(sessionRef);
  return parsed ? observationStore.get(parsed.providerId, parsed.localSessionId)?.publicState ?? null : null;
};

// The facts for the board's reading of a waiting task, from the session's committed public state in memory only.
export function resolveTaskCheckFacts(sessionRef, { observationStore, checkRead = pullRequestCheckRead }) {
  const state = committedState(sessionRef, observationStore);
  return checkFacts(state, state?.session, checkRead);
}

// The longest a report waits for its own read before it is judged on committed facts.
export const TASK_REPORT_READ_DEADLINE_MS = 20_000;

export async function readTaskCheckFacts(sessionRef, { observationStore, readNow, checkRead = pullRequestCheckRead, deadlineMs = TASK_REPORT_READ_DEADLINE_MS }) {
  let blocks = null;
  if (committedState(sessionRef, observationStore) && typeof readNow === "function") {
    let timer = null;
    try {
      blocks = await Promise.race([
        Promise.resolve().then(() => readNow(sessionRef)),
        new Promise((resolve) => { timer = setTimeout(resolve, deadlineMs, null); }),
      ]);
    } catch { blocks = null; } finally { clearTimeout(timer); }
  }
  const state = committedState(sessionRef, observationStore);
  return checkFacts(state, blocks ?? state?.session, checkRead, blocks !== null);
}
