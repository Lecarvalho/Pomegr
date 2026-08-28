import { execFile } from "node:child_process";

const MAX_PULL_REQUESTS = 8;
const CACHE_TTL_MS = 60_000;
const GH_TIMEOUT_MS = 6_000;
const GITHUB_PULL_REQUEST_URL = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,10})(?![A-Za-z0-9/?#])/g;
const GH_FIELDS = "number,title,state,url,headRefName,baseRefName,isDraft,mergedAt,additions,deletions,updatedAt";
const metadataCache = new Map();
const branchCache = new Map();

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
    const output = await ghRunner(cwd, ["pr", "view", url, "--json", GH_FIELDS]);
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
    const output = await ghRunner(cwd, ["pr", "list", "--state", "all", "--head", branch, "--limit", String(MAX_PULL_REQUESTS), "--json", GH_FIELDS]);
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
    if (item) itemsByUrl.set(item.url, item);
  }
  if (branchValues !== null) {
    queried = true;
    available = true;
    for (const value of branchValues) {
      const item = normalizePullRequest(value, "branch");
      if (item && !itemsByUrl.has(item.url)) itemsByUrl.set(item.url, item);
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
