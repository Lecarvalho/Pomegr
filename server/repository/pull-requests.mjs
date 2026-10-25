import { execFile } from "node:child_process";

const MAX_PULL_REQUESTS = 8;
const CACHE_TTL_MS = 60_000;
const GH_TIMEOUT_MS = 6_000;
const GITHUB_PULL_REQUEST_URL = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,10})(?![A-Za-z0-9/?#])/g;
const GH_FIELDS = "number,title,state,url,headRefName,baseRefName,isDraft,mergedAt,additions,deletions,updatedAt,headRefOid,isCrossRepository";
// Asked for with the metadata when gh can read it; a gh that cannot answers the metadata alone.
const GH_CHECK_FIELD = "statusCheckRollup";
const MAX_CHECK_ENTRIES = 200;
const MAX_CHECK_STATUSES = 256;
const PASSED_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const PENDING_RUN_STATUSES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);
const metadataCache = new Map();
const branchCache = new Map();
// Monitor-private: the latest check status read for a canonical pull-request URL.
const checkStatuses = new Map();

/**
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

/** @param {unknown} rollup @returns {"passed" | "failed" | "pending" | "none" | null} */
export function normalizeCheckStatus(rollup) {
  if (!Array.isArray(rollup) || rollup.length > MAX_CHECK_ENTRIES) return null;
  if (rollup.length === 0) return "none";
  const statuses = rollup.map(checkEntryStatus);
  if (statuses.includes(null)) return null;
  return statuses.includes("failed") ? "failed" : statuses.includes("pending") ? "pending" : "passed";
}

function recordCheckStatus(url, value, checkedAt) {
  const status = normalizeCheckStatus(value?.[GH_CHECK_FIELD]);
  const parsed = Date.parse(checkedAt);
  const readAt = Number.isFinite(parsed) ? parsed : Date.now();
  const held = checkStatuses.get(url);
  const headOid = typeof value?.headRefOid === "string" && /^[a-f0-9]{40}$/iu.test(value.headRefOid) ? value.headRefOid : null;
  // Monitor-private: only the task control plane asks whether the head branch lives in another repository.
  const read = { url, status, readAt, headOid, ...(typeof value?.isCrossRepository === "boolean" ? { crossRepository: value.isCrossRepository } : {}) };
  // Keep the last known-good observation. The caller's snapshot still records an unknown current read.
  if (status === null || held && (held.readAt > readAt || held.headOid !== null && headOid === null)) return read;
  checkStatuses.delete(url);
  checkStatuses.set(url, { status, readAt, headOid });
  if (checkStatuses.size > MAX_CHECK_STATUSES) checkStatuses.delete(checkStatuses.keys().next().value);
  return read;
}

/** @param {unknown} url @returns {{ status: "passed" | "failed" | "pending" | "none", readAt: number, headOid: string | null } | null} */
export function pullRequestCheckRead(url) {
  const held = typeof url === "string" ? checkStatuses.get(url) : undefined;
  return held ? { ...held } : null;
}

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

async function cached(cache, key, loader, fresh = false) {
  const previous = cache.get(key);
  if (!fresh && previous?.value && Date.now() - previous.timestamp < CACHE_TTL_MS) return previous.value;
  if (!fresh && previous?.pending) return previous.pending;
  const startedAt = new Date().toISOString();
  const pending = loader().then((loaded) => {
    const value = { loaded, checkedAt: startedAt };
    if (cache.get(key)?.pending === pending) {
      cache.set(key, loaded === null
        ? { timestamp: previous?.timestamp || 0, value: previous?.value || null, pending: null }
        : { timestamp: Date.now(), value, pending: null });
    }
    return value;
  });
  cache.set(key, { timestamp: previous?.timestamp || 0, value: previous?.value || null, pending });
  return pending;
}

async function metadataForUrl(cwd, url, ghRunner, fresh) {
  const load = async () => {
    const output = await readGhJson(ghRunner, cwd, ["pr", "view", url, "--json"]);
    if (!output) return null;
    try { return JSON.parse(output); } catch { return null; }
  };
  if (ghRunner === runGh) return cached(metadataCache, url, load, fresh);
  const checkedAt = new Date().toISOString();
  return { loaded: await load(), checkedAt };
}

async function pullRequestsForBranch(cwd, branch, ghRunner, fresh) {
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
  if (ghRunner === runGh) return cached(branchCache, `${cwd}\u0000${branch}`, load, fresh);
  const checkedAt = new Date().toISOString();
  return { loaded: await load(), checkedAt };
}

/**
 * @param {unknown} sessionCreations
 * @param {{ sessionCreations?: unknown, sessionUrls?: unknown, cwd?: string, branch?: string, historical?: boolean, fresh?: boolean, ghRunner?: typeof runGh }} [options]
 *   `fresh` skips the read cache, for a caller that must not judge an answer older than its own call.
 */
export async function readPullRequests(sessionCreations = [], options = {}) {
  const ghRunner = options.ghRunner || runGh;
  const fresh = options.fresh === true;
  const transcriptUrls = Array.isArray(options.sessionCreations)
    ? pullRequestUrls(options.sessionCreations)
    : Array.isArray(options.sessionUrls)
      ? pullRequestUrls(options.sessionUrls.map((url) => ({ url })))
      : pullRequestUrls(sessionCreations);
  const metadata = await Promise.all(transcriptUrls.map(async (url) => ({ url, result: await metadataForUrl(options.cwd, url, ghRunner, fresh) })));
  const branchResult = options.historical ? null : await pullRequestsForBranch(options.cwd, options.branch, ghRunner, fresh);
  const branchValues = branchResult?.loaded ?? null;
  const itemsByUrl = new Map();
  const checkReads = new Map();
  let queried = transcriptUrls.length > 0;
  let available = metadata.some(({ result }) => result.loaded !== null);

  for (const { url, result } of metadata) {
    const item = normalizePullRequest(result.loaded || {}, "session", url);
    if (!item) continue;
    itemsByUrl.set(item.url, item);
    checkReads.set(item.url, recordCheckStatus(item.url, result.loaded, result.checkedAt));
  }
  if (branchValues !== null) {
    queried = true;
    available = true;
    for (const value of branchValues) {
      const item = normalizePullRequest(value, "branch");
      if (!item) continue;
      if (!itemsByUrl.has(item.url)) itemsByUrl.set(item.url, item);
      checkReads.set(item.url, recordCheckStatus(item.url, value, branchResult.checkedAt));
    }
  }

  const reads = available
    ? [...metadata.filter(({ result }) => result.loaded !== null).map(({ result }) => result.checkedAt), branchValues !== null ? branchResult.checkedAt : null]
      .filter(Boolean).sort()
    : [];
  const items = [...itemsByUrl.values()].slice(0, MAX_PULL_REQUESTS);
  return {
    status: !queried || available ? "ready" : "unavailable",
    checkedAt: reads.at(-1) || null,
    // Monitor-private: the complete-when rule judges the block by this time.
    readAt: reads[0] || null,
    // Monitor-private, bound to this exact response rather than a later URL-cache observation.
    checkReads: items.map((item) => checkReads.get(item.url)),
    items,
  };
}
