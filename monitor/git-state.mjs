import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAIN_BRANCH_CANDIDATES = ["main", "master", "trunk", "develop"];
const MAX_COMMITS = 8;
const REMOTE_REFRESH_INTERVAL_MS = 60_000;
const REMOTE_TIMEOUT_MS = 10_000;
const remoteCaches = new Map();
const remoteCacheSetups = new Map();
let remoteCacheRoot = "";
let remoteCacheRootSetup = null;

function runGit(cwd, args, timeout = 1_500) {
  return execFileSync("git", [
    "-c", `safe.directory=${cwd}`,
    "-c", "core.quotepath=false",
    "-C", cwd,
    ...args,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
  });
}

function runGitAsync(cwd, args, timeout = REMOTE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile("git", [
      "-c", `safe.directory=${cwd}`,
      "-c", "core.quotepath=false",
      "-C", cwd,
      ...args,
    ], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function tryGit(cwd, args, timeout) {
  try {
    return runGit(cwd, args, timeout);
  } catch {
    return "";
  }
}

async function tryGitAsync(cwd, args, timeout) {
  try {
    return await runGitAsync(cwd, args, timeout);
  } catch {
    return "";
  }
}

function safeText(value, maximumLength) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function refExists(cwd, ref) {
  return Boolean(tryGit(cwd, ["rev-parse", "--verify", "--quiet", ref]));
}

async function refExistsAsync(cwd, ref) {
  return Boolean(await tryGitAsync(cwd, ["rev-parse", "--verify", "--quiet", ref], 1_500));
}

function localDefaultBranch(cwd, currentBranch) {
  const remoteHead = tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
  if (remoteHead && refExists(cwd, remoteHead)) return remoteHead.replace(/^origin\//, "");

  for (const name of MAIN_BRANCH_CANDIDATES) {
    if (refExists(cwd, `refs/heads/${name}`) || refExists(cwd, `refs/remotes/origin/${name}`)) return name;
  }
  return currentBranch;
}

async function localDefaultBranchAsync(cwd, currentBranch) {
  const remoteHead = (await tryGitAsync(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 1_500)).trim();
  if (remoteHead && await refExistsAsync(cwd, remoteHead)) return remoteHead.replace(/^origin\//, "");

  for (const name of MAIN_BRANCH_CANDIDATES) {
    const [local, remote] = await Promise.all([
      refExistsAsync(cwd, `refs/heads/${name}`),
      refExistsAsync(cwd, `refs/remotes/origin/${name}`),
    ]);
    if (local || remote) return name;
  }
  return currentBranch;
}

function ensureRemoteCacheRoot() {
  if (!remoteCacheRoot) remoteCacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-git-remote-"));
  return remoteCacheRoot;
}

async function ensureRemoteCacheRootAsync() {
  if (remoteCacheRoot) return remoteCacheRoot;
  if (!remoteCacheRootSetup) {
    remoteCacheRootSetup = mkdtemp(path.join(os.tmpdir(), "pomegr-git-remote-"))
      .then((directory) => {
        remoteCacheRoot = directory;
        return directory;
      })
      .finally(() => { remoteCacheRootSetup = null; });
  }
  return remoteCacheRootSetup;
}

function ensureRemoteCache(cwd) {
  let cache = remoteCaches.get(cwd);
  if (cache) return cache;

  const directory = fs.mkdtempSync(path.join(ensureRemoteCacheRoot(), "repo-"));
  runGit(cwd, ["init", "--bare", "--quiet", directory], 3_000);
  const commonDirectoryValue = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const commonDirectory = path.isAbsolute(commonDirectoryValue) ? commonDirectoryValue : path.resolve(cwd, commonDirectoryValue);
  const alternateFile = path.join(directory, "objects", "info", "alternates");
  fs.mkdirSync(path.dirname(alternateFile), { recursive: true });
  fs.writeFileSync(alternateFile, `${path.join(commonDirectory, "objects")}\n`, "utf8");
  cache = { directory, status: "checking", checkedAt: null, lastAttempt: 0, remoteBranch: "", pending: null };
  remoteCaches.set(cwd, cache);
  return cache;
}

async function ensureRemoteCacheAsync(cwd) {
  const cached = remoteCaches.get(cwd);
  if (cached) return cached;
  const pending = remoteCacheSetups.get(cwd);
  if (pending) return pending;

  const setup = (async () => {
    const root = await ensureRemoteCacheRootAsync();
    const directory = await mkdtemp(path.join(root, "repo-"));
    await runGitAsync(cwd, ["init", "--bare", "--quiet", directory], 3_000);
    const commonDirectoryValue = (await runGitAsync(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 1_500)).trim();
    const commonDirectory = path.isAbsolute(commonDirectoryValue) ? commonDirectoryValue : path.resolve(cwd, commonDirectoryValue);
    const alternateFile = path.join(directory, "objects", "info", "alternates");
    await mkdir(path.dirname(alternateFile), { recursive: true });
    await writeFile(alternateFile, `${path.join(commonDirectory, "objects")}\n`, "utf8");
    const cache = { directory, status: "checking", checkedAt: null, lastAttempt: 0, remoteBranch: "", pending: null };
    remoteCaches.set(cwd, cache);
    return cache;
  })().finally(() => { remoteCacheSetups.delete(cwd); });
  remoteCacheSetups.set(cwd, setup);
  return setup;
}

function remoteHeadBranch(output) {
  const match = output.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD\s*$/m);
  const branch = match?.[1]?.trim() || "";
  if (!branch || branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..")) return "";
  return branch;
}

function parseCounts(output) {
  const [behind, ahead] = output.trim().split(/\s+/).map(Number);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

function branchChangesIntegrated(cwd, gitDirectory, head) {
  const mergedTree = tryGit(cwd, [
    "--git-dir", gitDirectory,
    "merge-tree", "--write-tree", "--no-messages", "refs/pomegr/default", head,
  ], 5_000).trim();
  const remoteTree = tryGit(cwd, [
    "--git-dir", gitDirectory,
    "rev-parse", "refs/pomegr/default^{tree}",
  ]).trim();
  return Boolean(mergedTree && remoteTree && mergedTree === remoteTree);
}

async function branchChangesIntegratedAsync(cwd, gitDirectory, head) {
  const [mergedTree, remoteTree] = await Promise.all([
    tryGitAsync(cwd, [
      "--git-dir", gitDirectory,
      "merge-tree", "--write-tree", "--no-messages", "refs/pomegr/default", head,
    ], 5_000),
    tryGitAsync(cwd, [
      "--git-dir", gitDirectory,
      "rev-parse", "refs/pomegr/default^{tree}",
    ], 1_500),
  ]);
  return Boolean(mergedTree.trim() && remoteTree.trim() && mergedTree.trim() === remoteTree.trim());
}

function commitHistory(cwd, range, gitDirectory = "") {
  const output = tryGit(cwd, [
    ...(gitDirectory ? ["--git-dir", gitDirectory] : []),
    "log",
    `--max-count=${MAX_COMMITS}`,
    "--date=iso-strict",
    "--format=%h%x1f%cI%x1f%s%x1e",
    range,
  ], 2_500);
  if (!output) return [];
  return output.split("\u001e").flatMap((record) => {
    const [hash = "", committedAt = "", subject = ""] = record.trim().split("\u001f");
    if (!/^[0-9a-f]+$/i.test(hash) || !subject) return [];
    const parsedDate = new Date(committedAt);
    return [{
      hash: hash.slice(0, 12),
      subject: safeText(subject, 160),
      committedAt: Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString(),
    }];
  });
}

async function commitHistoryAsync(cwd, range, gitDirectory = "") {
  const output = await tryGitAsync(cwd, [
    ...(gitDirectory ? ["--git-dir", gitDirectory] : []),
    "log",
    `--max-count=${MAX_COMMITS}`,
    "--date=iso-strict",
    "--format=%h%x1f%cI%x1f%s%x1e",
    range,
  ], 2_500);
  if (!output) return [];
  return output.split("\u001e").flatMap((record) => {
    const [hash = "", committedAt = "", subject = ""] = record.trim().split("\u001f");
    if (!/^[0-9a-f]+$/i.test(hash) || !subject) return [];
    const parsedDate = new Date(committedAt);
    return [{
      hash: hash.slice(0, 12),
      subject: safeText(subject, 160),
      committedAt: Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString(),
    }];
  });
}

export async function refreshRemoteGitState(cwd, options = {}) {
  const cache = await ensureRemoteCacheAsync(cwd);
  const now = Date.now();
  if (cache.pending) return cache.pending;
  if (!options.force && now - cache.lastAttempt < REMOTE_REFRESH_INTERVAL_MS) return cache;

  cache.lastAttempt = now;
  if (!cache.checkedAt) cache.status = "checking";
  cache.pending = (async () => {
    try {
      const [remoteUrl, remoteHead] = await Promise.all([
        runGitAsync(cwd, ["remote", "get-url", "origin"]),
        runGitAsync(cwd, ["ls-remote", "--symref", "origin", "HEAD"]),
      ]);
      const branch = remoteHeadBranch(remoteHead);
      if (!remoteUrl.trim() || !branch) throw new Error("Remote default branch unavailable");
      await runGitAsync(cwd, [
        "--git-dir", cache.directory,
        "-c", `remote.pomegr.url=${remoteUrl.trim()}`,
        "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance",
        "pomegr", `+refs/heads/${branch}:refs/pomegr/default`,
      ]);
      cache.remoteBranch = branch;
      cache.checkedAt = new Date().toISOString();
      cache.status = "ready";
    } catch {
      cache.remoteBranch = "";
      cache.checkedAt = null;
      cache.status = "unavailable";
    } finally {
      cache.pending = null;
    }
    return cache;
  })();
  return cache.pending;
}

async function remoteRepositoryStateAsync(cwd, currentBranch, head) {
  let cache;
  try {
    cache = await ensureRemoteCacheAsync(cwd);
  } catch {
    const isMain = currentBranch === await localDefaultBranchAsync(cwd, currentBranch);
    return {
      isMain,
      comparison: null,
      commits: isMain ? await commitHistoryAsync(cwd, "HEAD") : [],
      remote: { status: "unavailable", checkedAt: null },
    };
  }
  if (!cache.pending && Date.now() - cache.lastAttempt >= REMOTE_REFRESH_INTERVAL_MS) void refreshRemoteGitState(cwd);
  if (cache.status !== "ready" || !cache.remoteBranch) {
    const isMain = currentBranch === await localDefaultBranchAsync(cwd, currentBranch);
    return {
      isMain,
      comparison: null,
      commits: isMain ? await commitHistoryAsync(cwd, "HEAD") : [],
      remote: { status: cache.status, checkedAt: null },
    };
  }

  const counts = parseCounts(await tryGitAsync(cwd, [
    "--git-dir", cache.directory,
    "rev-list", "--left-right", "--count", `refs/pomegr/default...${head}`,
  ], 2_500));
  if (!counts) return { isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } };

  const isMain = currentBranch === cache.remoteBranch;
  const integrated = !isMain && counts.ahead > 0 && await branchChangesIntegratedAsync(cwd, cache.directory, head);
  return {
    isMain,
    comparison: {
      branch: `origin/${safeText(cache.remoteBranch, 120)}`,
      kind: isMain ? "upstream" : "base",
      ahead: integrated ? 0 : counts.ahead,
      behind: counts.behind,
      integrated,
    },
    commits: isMain
      ? await commitHistoryAsync(cwd, "HEAD")
      : integrated ? [] : await commitHistoryAsync(cwd, `refs/pomegr/default..${head}`, cache.directory),
    remote: { status: "ready", checkedAt: cache.checkedAt },
  };
}

function remoteRepositoryState(cwd, currentBranch, head) {
  let cache;
  try {
    cache = ensureRemoteCache(cwd);
  } catch {
    const isMain = currentBranch === localDefaultBranch(cwd, currentBranch);
    return {
      isMain,
      comparison: null,
      commits: isMain ? commitHistory(cwd, "HEAD") : [],
      remote: { status: "unavailable", checkedAt: null },
    };
  }
  if (!cache.pending && Date.now() - cache.lastAttempt >= REMOTE_REFRESH_INTERVAL_MS) void refreshRemoteGitState(cwd);
  if (cache.status !== "ready" || !cache.remoteBranch) {
    const isMain = currentBranch === localDefaultBranch(cwd, currentBranch);
    return {
      isMain,
      comparison: null,
      commits: isMain ? commitHistory(cwd, "HEAD") : [],
      remote: { status: cache.status, checkedAt: null },
    };
  }

  const counts = parseCounts(tryGit(cwd, [
    "--git-dir", cache.directory,
    "rev-list", "--left-right", "--count", `refs/pomegr/default...${head}`,
  ], 2_500));
  if (!counts) return { isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } };

  const isMain = currentBranch === cache.remoteBranch;
  const integrated = !isMain && counts.ahead > 0 && branchChangesIntegrated(cwd, cache.directory, head);
  return {
    isMain,
    comparison: {
      branch: `origin/${safeText(cache.remoteBranch, 120)}`,
      kind: isMain ? "upstream" : "base",
      ahead: integrated ? 0 : counts.ahead,
      behind: counts.behind,
      integrated,
    },
    commits: isMain
      ? commitHistory(cwd, "HEAD")
      : integrated ? [] : commitHistory(cwd, `refs/pomegr/default..${head}`, cache.directory),
    remote: { status: "ready", checkedAt: cache.checkedAt },
  };
}

export function readGitState(cwd) {
  const empty = {
    available: false,
    branch: "Not a Git repository",
    files: [],
    isMain: false,
    comparison: null,
    commits: [],
    remote: { status: "unavailable", checkedAt: null },
  };
  if (!cwd) return empty;

  let branch = tryGit(cwd, ["branch", "--show-current"]).trim();
  const head = tryGit(cwd, ["rev-parse", "HEAD"]).trim();
  if (!head) return empty;
  if (!branch) branch = `detached@${head.slice(0, 12)}`;

  const output = tryGit(cwd, ["status", "--porcelain=v1"], 2_500);
  const files = output.split(/\r?\n/).filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    path: line.slice(3),
  }));
  const remoteState = branch.startsWith("detached@")
    ? { isMain: false, comparison: null, commits: commitHistory(cwd, "HEAD"), remote: { status: "unavailable", checkedAt: null } }
    : remoteRepositoryState(cwd, branch, head);

  return {
    available: true,
    branch: safeText(branch, 200),
    files,
    ...remoteState,
  };
}

export async function readGitStateAsync(cwd) {
  const empty = {
    available: false,
    branch: "Not a Git repository",
    files: [],
    isMain: false,
    comparison: null,
    commits: [],
    remote: { status: "unavailable", checkedAt: null },
  };
  if (!cwd) return empty;

  const [branchOutput, headOutput, statusOutput] = await Promise.all([
    tryGitAsync(cwd, ["branch", "--show-current"], 1_500),
    tryGitAsync(cwd, ["rev-parse", "HEAD"], 1_500),
    tryGitAsync(cwd, ["status", "--porcelain=v1"], 2_500),
  ]);
  let branch = branchOutput.trim();
  const head = headOutput.trim();
  if (!head) return empty;
  if (!branch) branch = `detached@${head.slice(0, 12)}`;

  const files = statusOutput.split(/\r?\n/).filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    path: line.slice(3),
  }));
  const remoteState = branch.startsWith("detached@")
    ? { isMain: false, comparison: null, commits: await commitHistoryAsync(cwd, "HEAD"), remote: { status: "unavailable", checkedAt: null } }
    : await remoteRepositoryStateAsync(cwd, branch, head);

  return {
    available: true,
    branch: safeText(branch, 200),
    files,
    ...remoteState,
  };
}

process.once("exit", () => {
  if (remoteCacheRoot) {
    try { fs.rmSync(remoteCacheRoot, { recursive: true, force: true }); } catch { /* Temporary cache cleanup is best-effort. */ }
  }
});
