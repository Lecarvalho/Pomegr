// The GitHub issue reader. It runs only on an explicit desktop action (never from a GET and never from the queue),
// through the installed GitHub CLI with argument arrays, as the signed-in user. Pomegr reads, stores, and forwards
// no token. Issue titles and bodies are text written by other people: this module bounds and normalizes them and
// returns fixed enums for every failure. No path, command, stderr, token, login, or URL leaves it.

import crypto from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";

export const ISSUE_LIST_LIMIT = 100;
export const ISSUE_TASK_TEXT_LIMIT = 4000;
export const ISSUE_TITLE_LIMIT = 200;
export const ISSUE_BODY_PREVIEW_LIMIT = 20_000;
export const ISSUE_NUMBER_MAX = 999_999_999;
export const ISSUE_HIDDEN_RANGE_LIMIT = 64;
export const ISSUE_HIDDEN_COUNT_LIMIT = 1000;
export const ISSUE_CREATE_TITLE_LIMIT = 120;

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// Creating an issue is one write, so it gets a longer deadline than a read.
const CREATE_TIMEOUT_MS = 20_000;
// Free text may span lines and tabs; every other control character is dropped from a promoted task's text.
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/gu;
const TITLE_RUNS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/gu;
const ASSOCIATIONS = Object.freeze({ OWNER: "owner", MEMBER: "member", COLLABORATOR: "collaborator" });
const CREATING_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"]);

export function isIssueNumber(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= ISSUE_NUMBER_MAX;
}

// A cut that never leaves half of a surrogate pair.
function cut(text, length) {
  if (text.length <= length) return text;
  const end = text.charCodeAt(length - 1) >= 0xd800 && text.charCodeAt(length - 1) <= 0xdbff ? length - 1 : length;
  return text.slice(0, end);
}

function wellFormed(value) {
  return typeof value === "string" ? value.toWellFormed() : "";
}

/**
 * The issue title of a task's text: its first line, control characters and runs of white space made one space,
 * trimmed, and cut to 120 characters without splitting a surrogate pair. Pure; "" means no title.
 *
 * @param {unknown} text
 */
export function issueTitleOf(text) {
  const firstLine = wellFormed(text).trim().split(/[\r\n\u2028\u2029]/u)[0] ?? "";
  return cut(firstLine.replace(TITLE_RUNS, " ").trim(), ISSUE_CREATE_TITLE_LIMIT).trim();
}

/** One bounded line: control characters and runs of white space become one space. */
function boundedTitle(value) {
  return cut(wellFormed(value).replace(TITLE_RUNS, " ").trim(), ISSUE_TITLE_LIMIT).trim();
}

/** Every `<!-- ... -->` range of the text; an unterminated one runs to the end. `end` is exclusive. */
function hiddenCommentRanges(text) {
  const ranges = [];
  let position = 0;
  while (ranges.length < ISSUE_HIDDEN_COUNT_LIMIT) {
    const start = text.indexOf("<!--", position);
    if (start === -1) break;
    const close = text.indexOf("-->", start + 4);
    const end = close === -1 ? text.length : close + 3;
    ranges.push({ start, end });
    position = end;
  }
  return ranges;
}

/**
 * The body as a promoted task stores it: hidden HTML comments removed, characters a task cannot hold dropped, then
 * trimmed. Pure.
 *
 * @param {unknown} body
 */
export function stripHiddenComments(body) {
  const text = wellFormed(body);
  let stripped = "";
  let position = 0;
  for (const { start, end } of hiddenCommentRanges(text)) {
    stripped += text.slice(position, start);
    position = end;
  }
  return (stripped + text.slice(position)).replace(TEXT_CONTROL, "").trim();
}

function isoInstant(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * One GitHub REST issue object as an `Issue`, or null for a pull request or anything outside the contract. Pure.
 * The author's login and every other field of the raw object are never read.
 *
 * @param {unknown} raw
 */
export function normalizeIssue(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Object.hasOwn(raw, "pull_request") || !isIssueNumber(raw.number) || typeof raw.title !== "string") return null;
  const title = boundedTitle(raw.title);
  if (title === "") return null;
  const original = typeof raw.body === "string" ? raw.body : "";
  const bodyTruncated = original.length > ISSUE_BODY_PREVIEW_LIMIT;
  const body = wellFormed(cut(original, ISSUE_BODY_PREVIEW_LIMIT));
  const found = hiddenCommentRanges(wellFormed(original));
  const ranges = found
    .filter((range) => range.start < body.length)
    .slice(0, ISSUE_HIDDEN_RANGE_LIMIT)
    .map(({ start, end }) => ({ start, end: Math.min(end, body.length) }));
  const stripped = stripHiddenComments(original);
  const taskText = stripped === "" ? title : `${title}\n\n${stripped}`;
  return {
    number: raw.number,
    title,
    body,
    bodyTruncated,
    hiddenComments: { count: found.length, ranges },
    taskText,
    characters: taskText.length,
    tooLong: bodyTruncated || taskText.length > ISSUE_TASK_TEXT_LIMIT,
    authorAssociation: ASSOCIATIONS[String(raw.author_association ?? "").toUpperCase()] ?? "outsider",
    updatedAt: isoInstant(raw.updated_at),
    digest: crypto.createHash("sha256").update(`${raw.title}\n${original}`, "utf8").digest("hex"),
  };
}

function visibilityOf(value) {
  const visibility = String(value ?? "").toUpperCase();
  return visibility === "PUBLIC" ? "public" : visibility === "PRIVATE" || visibility === "INTERNAL" ? "private" : "unknown";
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// Classifies a failed `gh api` read from the CLI's own message. The message stays in this function.
function failureStatus(failure, { single }) {
  if (failure.error?.code === "ENOENT") return "cli_missing";
  const text = `${failure.stderr}\n${failure.error?.message ?? ""}`;
  if (/HTTP 401|gh auth login/iu.test(text)) return "not_signed_in";
  if (/HTTP 410/u.test(text)) return "issues_disabled";
  if (/HTTP 404/u.test(text)) return single ? "not_found" : "no_access";
  if (/HTTP 403/u.test(text)) return "no_access";
  return "unavailable";
}

/**
 * @param {{ execFile?: Function, timeoutMs?: number, maxBytes?: number }} [options]
 */
export function createIssueReader({ execFile = nodeExecFile, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  // Resolves `{ ok: true, stdout }` or `{ ok: false, error, stderr }`; never rejects and never throws.
  // `input` (text for the child's standard input) is how a write passes text: it is never an argument.
  function runGh(root, args, { input, deadlineMs = timeoutMs } = {}) {
    return new Promise((resolve) => {
      const failed = (error, stderr = "") => resolve({ ok: false, error, stderr: typeof stderr === "string" ? stderr : "" });
      try {
        const child = execFile("gh", args, {
          cwd: typeof root === "string" && root !== "" ? root : undefined,
          encoding: "utf8",
          timeout: deadlineMs,
          maxBuffer: maxBytes,
          windowsHide: true,
          env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
        }, (error, stdout, stderr) => {
          if (error) return failed(error, stderr);
          if (typeof stdout !== "string" || stdout.length > maxBytes) return failed(new Error("output"), "");
          return resolve({ ok: true, stdout });
        });
        if (input !== undefined) {
          // A fake or a child without a pipe has no stdin; the call then simply sends nothing.
          child?.stdin?.on?.("error", () => {});
          child?.stdin?.end?.(input);
        }
      } catch (error) {
        failed(error);
      }
    });
  }

  const validRoot = (root) => typeof root === "string" && root !== "";

  async function connection() {
    const result = await runGh(undefined, ["auth", "status", "--hostname", "github.com"]);
    if (result.ok) return "connected";
    return result.error?.code === "ENOENT" ? "cli_missing" : "not_signed_in";
  }

  async function repositoryAccess(root) {
    const closed = { visibility: "unknown", capabilities: ["no_access"] };
    if (!validRoot(root)) return closed;
    const result = await runGh(root, ["repo", "view", "--json", "visibility,hasIssuesEnabled,viewerPermission"]);
    const value = result.ok ? parseJson(result.stdout) : undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return closed;
    const visibility = visibilityOf(value.visibility);
    if (value.hasIssuesEnabled === false) return { visibility, capabilities: ["issues_disabled"] };
    const capabilities = ["read_issues"];
    if (visibility === "public" || CREATING_PERMISSIONS.has(String(value.viewerPermission ?? "").toUpperCase())) capabilities.push("create_issues");
    return { visibility, capabilities };
  }

  async function listOpenIssues(root) {
    const empty = (status) => ({ status, issues: [], truncated: false });
    if (!validRoot(root)) return empty("unavailable");
    const result = await runGh(root, ["api", `repos/{owner}/{repo}/issues?state=open&per_page=${ISSUE_LIST_LIMIT}`]);
    if (!result.ok) return empty(failureStatus(result, { single: false }));
    const raw = parseJson(result.stdout);
    if (!Array.isArray(raw)) return empty("unavailable");
    const issues = raw.slice(0, ISSUE_LIST_LIMIT).map(normalizeIssue).filter((issue) => issue !== null);
    return { status: "ok", issues, truncated: raw.length >= ISSUE_LIST_LIMIT };
  }

  async function readIssue(root, number) {
    const none = (status) => ({ status, issue: null });
    if (!isIssueNumber(number)) return none("not_found");
    if (!validRoot(root)) return none("unavailable");
    const result = await runGh(root, ["api", `repos/{owner}/{repo}/issues/${number}`]);
    if (!result.ok) return none(failureStatus(result, { single: true }));
    const raw = parseJson(result.stdout);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return none("unavailable");
    if (Object.hasOwn(raw, "pull_request") || (typeof raw.state === "string" && raw.state.toLowerCase() !== "open")) return none("not_found");
    const issue = normalizeIssue(raw);
    return issue === null || issue.number !== number ? none("unavailable") : { status: "ok", issue };
  }

  /**
   * Creates one issue with `gh api --method POST`. The JSON `{ title, body }` goes to the child's standard input; no
   * part of it is an argument. Answers `{ status: "ok", number }` only for a valid issue number, else one fixed failure.
   */
  async function createIssue(root, { title, body }) {
    const none = (status) => ({ status, number: null });
    if (!validRoot(root)) return none("failed");
    if (typeof title !== "string" || title === "" || typeof body !== "string") return none("failed");
    const input = JSON.stringify({ title: wellFormed(title), body: wellFormed(body) });
    const result = await runGh(root, ["api", "--method", "POST", "repos/{owner}/{repo}/issues", "--input", "-"], { input, deadlineMs: CREATE_TIMEOUT_MS });
    if (!result.ok) {
      const status = failureStatus(result, { single: false });
      return none(status === "unavailable" || status === "not_found" ? "failed" : status);
    }
    const raw = parseJson(result.stdout);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !isIssueNumber(raw.number)) return none("failed");
    return { status: "ok", number: raw.number };
  }

  return Object.freeze({ connection, repositoryAccess, listOpenIssues, readIssue, createIssue });
}
