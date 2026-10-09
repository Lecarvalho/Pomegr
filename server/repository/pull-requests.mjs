import { execFile } from "node:child_process";

const MAX_PULL_REQUESTS = 8;
const CACHE_TTL_MS = 60_000;
const GH_TIMEOUT_MS = 6_000;
const GITHUB_PULL_REQUEST_URL = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,10})(?![A-Za-z0-9/?#])/g;
const GH_FIELDS = "number,title,state,url,headRefName,baseRefName,isDraft,mergedAt,additions,deletions,updatedAt";
// Asked for with the metadata when gh can read it; a gh that cannot answers the metadata alone.
const GH_CHECK_FIELD = "statusCheckRollup";
const MAX_CHECK_ENTRIES = 200;
const MAX_CHECK_STATUSES = 256;
const PASSED_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const PENDING_RUN_STATUSES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);
const metadataCache = new Map();
const branchCache = new Map();
// Monitor-private: the latest check status read for a canonical pull-request URL. It never joins the
// normalized pull-request item, so no browser surface carries it.
const checkStatuses = new Map();

/**
 * Read bounded URLs from normalized provider evidence. Provider transcript
 * parsing belongs in adapters; this generic enrichment module never receives
 * a provider-native record or transcript path.
 *
 * @param {unknown} creations
 */
export function pullRequestUrls(creations) {
  if (!Array.isArray(creations)) return [];
  const urls = new Set();
  for (const creation of creations) {
    if (typeof creation?.url !== "string" || !pullRequestReference(creation.url)) continue;
    urls.add(creation.url);
    if (urls.size >= MAX_PULL_REQUESTS) break;
  }
  return [...urls];
}

function safeText(value, maximumLength) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength)
    : "";
}

function canonicalPullRequestUrl(owner, repository, number) {
  return `https://github.com/${owner}/${repository}/pull/${number}`;
}

function pullRequestReference(url) {
  GITHUB_PULL_REQUEST_URL.lastIndex = 0;
  const match = GITHUB_PULL_REQUEST_URL.exec(url);
  if (!match || match[0] !== url) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return {
    owner: match[1],
    repository: match[2],
    number,
    url: canonicalPullRequestUrl(match[1], match[2], number),
  };
}

function runGh(cwd, args) {
  return new Promise((resolve) => {
    execFile("gh", args, {
      cwd: cwd || undefined,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function normalizedState(value) {
  if (value?.mergedAt) return "merged";
  const state = String(value?.state || "").toLowerCase();
  return state === "open" || state === "closed" ? state : "unknown";
}

// One recognized check entry as passed, failed, or pending; anything else is unknown.
function checkEntryStatus(entry) {
  if (entry?.__typename === "CheckRun") {
    if (entry.status === "COMPLETED") return PASSED_CONCLUSIONS.has(entry.conclusion) ? "passed" : FAILED_CONCLUSIONS.has(entry.conclusion) ? "failed" : null;
    return PENDING_RUN_STATUSES.has(entry.status) ? "pending" : null;
  }
  if (entry?.__typename === "StatusContext") {
    if (entry.state === "SUCCESS") return "passed";
    if (entry.state === "FAILURE" || entry.state === "ERROR") return "failed";
    return entry.state === "PENDING" || entry.state === "EXPECTED" ? "pending" : null;
  }
  return null;
}

/**
 * Normalize gh's `statusCheckRollup` list to the aggregate check status of a pull request's head
 * commit: `none` (no check), `failed` (any check failed), `pending` (none failed, one unfinished), or
 * `passed`. A missing, oversized, or unrecognized list is `null` (unknown). Names, URLs, and every
 * other field of a check are dropped here.
 *
 * @param {unknown} rollup
 * @returns {"passed" | "failed" | "pending" | "none" | null}
 */
export function normalizeCheckStatus(rollup) {
  if (!Array.isArray(rollup) || rollup.length > MAX_CHECK_ENTRIES) return null;
  if (rollup.length === 0) return "none";
  const statuses = rollup.map(checkEntryStatus);
  if (statuses.includes(null)) return null;
  return statuses.includes("failed") ? "failed" : statuses.includes("pending") ? "pending" : "passed";
}

// `checkedAt` is the time of the gh read that produced `value` (a cached read keeps its own time), kept in
// memory with the status so a consumer can tell how old the fact is. A read older than the status already
// held does not replace it.
function recordCheckStatus(url, value, checkedAt) {
  const status = normalizeCheckStatus(value?.[GH_CHECK_FIELD]);
  const parsed = Date.parse(checkedAt);
  const readAt = Number.isFinite(parsed) ? parsed : Date.now();
  const held = checkStatuses.get(url);
  if (status !== null && held && held.readAt > readAt) return;
  checkStatuses.delete(url);
  if (status === null) return;
  checkStatuses.set(url, { status, readAt });
  if (checkStatuses.size > MAX_CHECK_STATUSES) checkStatuses.delete(checkStatuses.keys().next().value);
}

/**
 * The aggregate check status last read for a normalized pull-request URL, or `null` when the latest
 * read did not establish one. A memory lookup: it never runs gh. For the task done-when rule only.
 *
 * @param {unknown} url
 * @returns {"passed" | "failed" | "pending" | "none" | null}
 */
export function pullRequestCheckStatus(url) {
  return (typeof url === "string" && checkStatuses.get(url)?.status) || null;
}

/**
 * The same status together with the time (epoch milliseconds) of the read that established it, or
 * `null` when no read established one. A memory lookup; for the task done-when rule only.
 *
 * @param {unknown} url
 * @returns {{ status: "passed" | "failed" | "pending" | "none", readAt: number } | null}
 */
export function pullRequestCheckRead(url) {
  const held = typeof url === "string" ? checkStatuses.get(url) : undefined;
  return held ? { status: held.status, readAt: held.readAt } : null;
}

// Ask for the check field with the metadata; when that read fails, the metadata alone, so a gh that
// cannot read checks still answers the pull request.
async function readGhJson(ghRunner, cwd, args) {
  return await ghRunner(cwd, [...args, `${GH_FIELDS},${GH_CHECK_FIELD}`]) || ghRunner(cwd, [...args, GH_FIELDS]);
}

export function normalizePullRequest(value, association = "session", fallbackUrl = "") {
  const reference = pullRequestReference(typeof value?.url === "string" ? value.url : fallbackUrl);
  const number = Number(value?.number || reference?.number);
  if (!reference || !Number.isSafeInteger(number) || number !== reference.number) return null;
  const additions = Number(value?.additions);
  const deletions = Number(value?.deletions);
  const updatedAt = value?.updatedAt ? new Date(value.updatedAt) : null;
  return {
    host: "github",
    repository: `${reference.owner}/${reference.repository}`,
    number,
    title: safeText(value?.title, 180) || `Pull request #${number}`,
    url: reference.url,
    state: normalizedState(value),
    draft: Boolean(value?.isDraft),
    headBranch: safeText(value?.headRefName, 200),
    baseBranch: safeText(value?.baseRefName, 200),
    additions: Number.isSafeInteger(additions) && additions >= 0 ? additions : null,
    deletions: Number.isSafeInteger(deletions) && deletions >= 0 ? deletions : null,
    updatedAt: updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt.toISOString() : null,
    association: association === "branch" ? "branch" : "session",
  };
}

async function cached(cache, key, loader) {
  const previous = cache.get(key);
  if (previous?.value && Date.now() - previous.timestamp < CACHE_TTL_MS) return previous.value;
  if (previous?.pending) return previous.pending;
  const pending = loader().then((loaded) => {
    const value = { loaded, checkedAt: new Date().toISOString() };
    cache.set(key, { timestamp: Date.now(), value, pending: null });
    return value;
  });
  cache.set(key, { timestamp: previous?.timestamp || 0, value: previous?.value || null, pending });
  return pending;
}

async function metadataForUrl(cwd, url, ghRunner) {
  const load = async () => {
    const output = await readGhJson(ghRunner, cwd, ["pr", "view", url, "--json"]);
    if (!output) return null;
    try { return JSON.parse(output); } catch { return null; }
  };
  return ghRunner === runGh
    ? cached(metadataCache, url, load)
    : { loaded: await load(), checkedAt: new Date().toISOString() };
}

async function pullRequestsForBranch(cwd, branch, ghRunner) {
  if (!cwd || !branch || branch.startsWith("detached@") || branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..")) return null;
  const load = async () => {
    const output = await readGhJson(ghRunner, cwd, ["pr", "list", "--state", "all", "--head", branch, "--limit", String(MAX_PULL_REQUESTS), "--json"]);
    if (!output) return null;
    try {
      const parsed = JSON.parse(output);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  return ghRunner === runGh
    ? cached(branchCache, `${cwd}\u0000${branch}`, load)
    : { loaded: await load(), checkedAt: new Date().toISOString() };
}

/**
 * Enrich normalized pull-request creation evidence with GitHub metadata.
 * The first argument is retained for existing callers, but it accepts only
 * normalized creation objects (never provider records).
 *
 * @param {unknown} sessionCreations
 * @param {{ sessionCreations?: unknown, sessionUrls?: unknown, cwd?: string, branch?: string, historical?: boolean, ghRunner?: typeof runGh }} [options]
 */
export async function readPullRequests(sessionCreations = [], options = {}) {
  const ghRunner = options.ghRunner || runGh;
  const transcriptUrls = Array.isArray(options.sessionCreations)
    ? pullRequestUrls(options.sessionCreations)
    : Array.isArray(options.sessionUrls)
      ? pullRequestUrls(options.sessionUrls.map((url) => ({ url })))
      : pullRequestUrls(sessionCreations);
  const metadata = await Promise.all(transcriptUrls.map(async (url) => ({ url, result: await metadataForUrl(options.cwd, url, ghRunner) })));
  const branchResult = options.historical ? null : await pullRequestsForBranch(options.cwd, options.branch, ghRunner);
  const branchValues = branchResult?.loaded ?? null;
  const itemsByUrl = new Map();
  let queried = transcriptUrls.length > 0;
  let available = metadata.some(({ result }) => result.loaded !== null);

  for (const { url, result } of metadata) {
    const item = normalizePullRequest(result.loaded || {}, "session", url);
    if (!item) continue;
    itemsByUrl.set(item.url, item);
    if (result.loaded !== null) recordCheckStatus(item.url, result.loaded, result.checkedAt);
  }
  if (branchValues !== null) {
    queried = true;
    available = true;
    for (const value of branchValues) {
      const item = normalizePullRequest(value, "branch");
      if (!item) continue;
      if (!itemsByUrl.has(item.url)) itemsByUrl.set(item.url, item);
      recordCheckStatus(item.url, value, branchResult.checkedAt);
    }
  }

  return {
    status: !queried || available ? "ready" : "unavailable",
    checkedAt: available
      ? [...metadata.filter(({ result }) => result.loaded !== null).map(({ result }) => result.checkedAt), branchValues !== null ? branchResult.checkedAt : null]
        .filter(Boolean).sort().at(-1) || null
      : null,
    items: [...itemsByUrl.values()].slice(0, MAX_PULL_REQUESTS),
  };
}
