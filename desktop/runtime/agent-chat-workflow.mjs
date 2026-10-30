// The repository's workflow sources, read for Aril's prompt: which of a few fixed files changed after the owner settled
// Aril's settings and memory. Names and dates only; no file content leaves the repository. Git runs read-only.

import { execFile as execFileChild } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const WORKFLOW_FILES = Object.freeze(["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", ".pomegr/signals.md"]);
const WORKFLOWS_DIRECTORY = ".github/workflows";
const WORKFLOW_FILE_LIMIT = 40;
const NAME_LIMIT = 200;
const UNSAFE_NAME = /[\p{Cc}\p{Zl}\p{Zp}<>\\]/u;
const TIMEOUT_MS = 5000;
const CONCURRENCY = 8;
const OUTPUT_BYTES = 1024 * 1024;
const GIT_PREFIX = ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false"];

/** A repository-relative name from the fixed list, or a file under the workflows folder. */
export function isWorkflowSourcePath(name) {
  if (typeof name !== "string" || name.length > NAME_LIMIT || name.includes("..") || UNSAFE_NAME.test(name)) return false;
  return WORKFLOW_FILES.includes(name) || (name.startsWith(`${WORKFLOWS_DIRECTORY}/`) && name.length > WORKFLOWS_DIRECTORY.length + 1);
}

/** The workflow sources that exist in the root: the fixed files, then at most 40 workflow files in name order. */
export async function workflowSources(root) {
  const fixed = [];
  for (const name of WORKFLOW_FILES) if ((await stat(path.join(root, name)).catch(() => null))?.isFile()) fixed.push(name);
  const directory = path.join(root, WORKFLOWS_DIRECTORY);
  const listed = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
  const workflows = listed.filter((entry) => entry.isFile())
    .map((entry) => `${WORKFLOWS_DIRECTORY}/${path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")}`)
    .filter(isWorkflowSourcePath).sort().slice(0, WORKFLOW_FILE_LIMIT);
  return [...fixed, ...workflows];
}

// Porcelain `-z` entries are `XY path`; a rename or copy is followed by its original path, which is not an entry.
function changedPaths(output) {
  const found = new Set();
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].length < 4) continue;
    found.add(parts[index].slice(3));
    if (/[RC]/u.test(parts[index].slice(0, 2))) index += 1;
  }
  return found;
}

const HASH = /^[0-9a-f]{40,64}$/u;
const REF = /^refs\/[A-Za-z0-9._/-]+$/u;
// What the key cannot see (an ignore rule outside the files it reads, for one) ends here at the latest.
const FACTS_MAX_AGE_MS = 5 * 60_000;

// The settled time: the older of the settings' time and the memory's last change; `undefined` when nothing is settled.
function settledSince(aril) {
  const settled = [Date.parse(aril?.settings?.settledAt), typeof aril?.memory?.updatedAt === "number" ? aril.memory.updatedAt : Number.NaN].filter(Number.isFinite);
  return settled.length === 0 ? undefined : Math.min(...settled);
}

const fileKey = async (file) => {
  const info = await stat(file).catch(() => null);
  return info ? `${info.mtimeMs}:${info.ctimeMs}:${info.size}` : "-";
};

// The repository's HEAD commit and the folders Git keeps its state in, read from the files: no Git process. Null when it cannot be told
// (no repository, an unborn branch, a ref storage this does not read), which means a full read.
async function repositoryState(root) {
  const dot = path.join(root, ".git");
  let gitDir = dot;
  if (!(await stat(dot)).isDirectory()) {
    const link = (await readFile(dot, "utf8")).match(/^gitdir:\s*(.+?)\s*$/mu);
    if (!link) return null;
    gitDir = path.resolve(root, link[1]);
  }
  const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
  const common = await readFile(path.join(gitDir, "commondir"), "utf8").then((value) => path.resolve(gitDir, value.trim()), () => gitDir);
  let commit = HASH.test(head) ? head : null;
  const ref = head.match(/^ref:\s*(\S+)$/u)?.[1];
  if (commit === null && ref && REF.test(ref) && !ref.includes("..")) {
    const loose = (await readFile(path.join(common, ref), "utf8").catch(() => "")).trim();
    commit = HASH.test(loose) ? loose : null;
    if (commit === null) {
      for (const line of (await readFile(path.join(common, "packed-refs"), "utf8").catch(() => "")).split(/\r?\n/u)) {
        const [hash, name] = line.split(" ");
        if (name === ref && HASH.test(hash)) commit = hash;
      }
    }
  }
  return commit === null ? null : { commit, gitDir, common };
}

/**
 * A string that changes whenever the answer for these sources could: the HEAD commit (the last commit of a source), the index (what is
 * staged or tracked), the ignore rules Git reads from the root and its own exclude file, and the times and size of each source (an edit).
 * Null when any of it cannot be read.
 */
async function workflowKey(root, sources) {
  const state = await repositoryState(root);
  if (!state) return null;
  const parts = [state.commit, await fileKey(path.join(state.gitDir, "index")), await fileKey(path.join(root, ".gitignore")), await fileKey(path.join(state.common, "info", "exclude"))];
  for (const name of sources) {
    const key = await fileKey(path.join(root, name));
    if (key === "-") return null;
    parts.push(`${name}:${key}`);
  }
  return parts.join("\n");
}

// Everything the answer needs from Git and the file system, apart from the settled time: the last commit of each source, and which are
// uncommitted with the time of their last edit.
async function readWorkflowFacts(root, sources, git) {
  const committed = new Array(sources.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, async () => {
    for (let index = next++; index < sources.length; index = next++) {
      const seconds = Number((await git(["log", "-1", "--format=%ct", "--", sources[index]])).trim());
      committed[index] = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    }
  }));
  const dirty = changedPaths(await git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...sources]));
  const edited = new Map();
  for (const name of sources) if (dirty.has(name)) edited.set(name, await stat(path.join(root, name)).then((file) => file.mtime.toISOString(), () => null));
  return { sources, committed, edited };
}

function workflowChangesSince(facts, since) {
  const changes = [];
  for (const [index, name] of facts.sources.entries()) {
    if (facts.edited.has(name)) changes.push({ path: name, changedAt: facts.edited.get(name), uncommitted: true });
    else if (facts.committed[index] !== null && facts.committed[index] > since) changes.push({ path: name, changedAt: new Date(facts.committed[index]).toISOString(), uncommitted: false });
  }
  return changes;
}

// One read, within `timeoutMs` in total. With `kept` (a map of the facts last read for each root), the facts are reused while their key is the
// same one; a key that cannot be read, or any difference, reads everything again.
async function readChanges(root, aril, { execFile, timeoutMs }, kept = null, { now = Date.now, maxAgeMs = FACTS_MAX_AGE_MS } = {}) {
  const since = settledSince(aril);
  if (since === undefined) return undefined;
  const controller = new AbortController();
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
  const git = (args) => new Promise((resolve, reject) => execFile("git", [...GIT_PREFIX, ...args], {
    cwd: root, shell: false, windowsHide: true, signal: controller.signal, timeout: timeoutMs, maxBuffer: OUTPUT_BYTES, encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
  const read = async () => {
    const sources = await workflowSources(root);
    if (sources.length === 0) return [];
    // The key is read before the facts, so an edit during the read makes the next key differ.
    const key = kept ? await workflowKey(root, sources).catch(() => null) : null;
    const known = key === null ? undefined : kept.get(root);
    if (known && known.key === key && now() - known.at < maxAgeMs) return workflowChangesSince(known.facts, since);
    const facts = await readWorkflowFacts(root, sources, git);
    if (kept) { if (key === null) kept.delete(root); else kept.set(root, { key, at: now(), facts }); }
    return workflowChangesSince(facts, since);
  };
  try { return await Promise.race([read(), expired]); } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * The sources that changed after the older of the time the owner settled the settings and the memory's last change: a last commit after
 * it, or uncommitted changes. `undefined` when nothing is settled, `null` when Git fails or the total time runs out.
 * `{ path, changedAt, uncommitted }` each; `changedAt` is the last commit, or the last edit of an uncommitted file.
 */
export function readWorkflowChanges(root, aril, { execFile = execFileChild, timeoutMs = TIMEOUT_MS } = {}) {
  return readChanges(root, aril, { execFile, timeoutMs });
}

/**
 * The same read, which keeps what it read from Git for each root. A turn whose key is the one of the last read starts no Git process;
 * a new commit, a staged or edited source, a source that appeared or went, or a key that cannot be read reads everything again. The
 * settled time is not part of the key: the changes are worked out from the kept facts on every read. A failed read keeps nothing.
 */
export function createWorkflowReader({ execFile = execFileChild, timeoutMs = TIMEOUT_MS, now = Date.now, maxAgeMs = FACTS_MAX_AGE_MS } = {}) {
  const kept = new Map();
  return Object.freeze({ read: (root, aril) => readChanges(root, aril, { execFile, timeoutMs }, kept, { now, maxAgeMs }) });
}
