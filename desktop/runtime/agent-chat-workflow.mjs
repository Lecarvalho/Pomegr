// The repository's workflow sources, read for Aril's prompt: which of a few fixed files changed after the owner settled
// Aril's settings and memory. Names and dates only; no file content leaves the repository. Git runs read-only.

import { execFile as execFileChild } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
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

/**
 * The sources that changed after the oldest time the owner settled the settings or a memory entry: a last commit after
 * it, or uncommitted changes. `undefined` when nothing is settled, `null` when Git fails or the total time runs out.
 * `{ path, changedAt, uncommitted }` each; `changedAt` is the last commit, or the last edit of an uncommitted file.
 */
export async function readWorkflowChanges(root, aril, { execFile = execFileChild, timeoutMs = TIMEOUT_MS } = {}) {
  const settled = [Date.parse(aril?.settings?.settledAt), ...(Array.isArray(aril?.memory) ? aril.memory : [])
    .map((entry) => (typeof entry?.updatedAt === "number" ? entry.updatedAt : Number.NaN))].filter(Number.isFinite);
  if (settled.length === 0) return undefined;
  const since = Math.min(...settled);
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
    const committed = new Array(sources.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, async () => {
      for (let index = next++; index < sources.length; index = next++) {
        const seconds = Number((await git(["log", "-1", "--format=%ct", "--", sources[index]])).trim());
        committed[index] = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
      }
    }));
    const dirty = changedPaths(await git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...sources]));
    const changes = [];
    for (const [index, name] of sources.entries()) {
      if (dirty.has(name)) {
        const edited = await stat(path.join(root, name)).then((file) => file.mtime.toISOString(), () => null);
        changes.push({ path: name, changedAt: edited, uncommitted: true });
      } else if (committed[index] !== null && committed[index] > since) changes.push({ path: name, changedAt: new Date(committed[index]).toISOString(), uncommitted: false });
    }
    return changes;
  };
  try { return await Promise.race([read(), expired]); } catch { return null; } finally { clearTimeout(timer); }
}
