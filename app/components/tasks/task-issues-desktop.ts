"use client";

// The renderer's only way to GitHub issues: the desktop preload's `taskIssues` bridge (fixed IPC channel
// `pomegr:task-issues`). Every answer is checked here, so a malformed one reads as `unavailable`. Issue titles and
// bodies are text written by other people: render them as text only, and never keep them in browser storage.

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_NUMBER = 999_999_999;
const LIMITS = { issues: 100, title: 200, body: 20_000, ranges: 64, time: 40 } as const;

export type GitHubConnection = "connected" | "not_signed_in" | "cli_missing";
export type GitHubVisibility = "private" | "public" | "unknown";
export type GitHubCapability = "read_issues" | "create_issues" | "issues_disabled" | "no_access";
export type GitHubRepositoryAccess = { visibility: GitHubVisibility; capabilities: GitHubCapability[] };
/** `repository` is null unless the connection is `connected` and the monitor recognizes the repository root. */
export type GitHubStatus = { connection: GitHubConnection; repository: GitHubRepositoryAccess | null };

export type IssueAuthorAssociation = "owner" | "member" | "collaborator" | "outsider";
export type IssueListStatus = "ok" | "cli_missing" | "not_signed_in" | "no_access" | "issues_disabled" | "not_found" | "unavailable";

export type TaskIssue = {
  number: number;
  /** One line, at most 200 characters. */
  title: string;
  /** The original body, cut at 20000 characters for the preview. */
  body: string;
  bodyTruncated: boolean;
  /** Hidden HTML comments: `ranges` are offsets into `body`, each `start` inclusive and `end` exclusive. */
  hiddenComments: { count: number; ranges: { start: number; end: number }[] };
  /** Length of the task text a promote would store (title, blank line, body without hidden comments). */
  characters: number;
  /** The task text would pass 4000 characters: a promote answers `limit`. */
  tooLong: boolean;
  authorAssociation: IssueAuthorAssociation;
  updatedAt: string | null;
  /** Sent back with the number on promote; the monitor answers `conflict` when the issue changed since. */
  digest: string;
  /** The task this issue was promoted to, else null. */
  taskId: string | null;
};

/** `issues` is empty unless `status` is `ok`. `truncated`: GitHub held more open issues than the 100 listed. */
export type TaskIssueList = { status: IssueListStatus; readAt: string | null; truncated: boolean; issues: TaskIssue[] };

export type TaskIssueError = "invalid" | "not_found" | "conflict" | "limit" | "unavailable";
export type TaskIssueResult<Value> = { ok: true; value: Value } | { ok: false; error: TaskIssueError };
export type GitHubSignInStatus = "opened" | "cancelled" | "cli_missing" | "unsupported_platform" | "unavailable";

type Operation = "status" | "list" | "promote" | "sign_in";
type Bridge = { taskIssues(repositoryId: string, operation: Operation, payload: Record<string, unknown>): Promise<unknown> };
type Json = Record<string, unknown>;

const CONNECTIONS = new Set<string>(["connected", "not_signed_in", "cli_missing"]);
const VISIBILITIES = new Set<string>(["private", "public", "unknown"]);
const CAPABILITIES = new Set<string>(["read_issues", "create_issues", "issues_disabled", "no_access"]);
const ASSOCIATIONS = new Set<string>(["owner", "member", "collaborator", "outsider"]);
const LIST_STATUSES = new Set<string>(["ok", "cli_missing", "not_signed_in", "no_access", "issues_disabled", "not_found", "unavailable"]);
const ERRORS = new Set<string>(["invalid", "not_found", "conflict", "limit", "unavailable"]);
const SIGN_IN_STATUSES = new Set<string>(["opened", "cancelled", "cli_missing", "unsupported_platform", "unavailable"]);

const record = (value: unknown): Json | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
const count = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const nullableTime = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length <= LIMITS.time && !Number.isNaN(Date.parse(value)));

function issueBridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { pomegrDesktop?: Partial<Bridge> }).pomegrDesktop;
  return typeof bridge?.taskIssues === "function" ? bridge as Bridge : undefined;
}

/** False in a browser and on a desktop build from before the bridge: GitHub issues are then desktop only. */
export function taskIssuesAvailable(): boolean {
  return issueBridge() !== undefined;
}

/** One bridge call. Never throws: a missing bridge, an IPC failure and an unreadable answer are all `unavailable`. */
async function call<Value>(repositoryId: string, operation: Operation, payload: Record<string, unknown>, parse: (answer: Json) => Value | null): Promise<TaskIssueResult<Value>> {
  const bridge = issueBridge();
  if (!bridge || !REPOSITORY_ID.test(repositoryId)) return { ok: false, error: bridge ? "invalid" : "unavailable" };
  try {
    const answer = record(await bridge.taskIssues(repositoryId, operation, payload));
    if (answer?.ok === true) {
      const value = parse(answer);
      if (value !== null) return { ok: true, value };
    } else if (typeof answer?.error === "string" && ERRORS.has(answer.error)) {
      return { ok: false, error: answer.error as TaskIssueError };
    }
  } catch {
    // Falls through to the fixed unavailable result.
  }
  return { ok: false, error: "unavailable" };
}

function parseAccess(value: unknown): GitHubRepositoryAccess | null {
  const access = record(value);
  if (!access || !VISIBILITIES.has(access.visibility as string) || !Array.isArray(access.capabilities)) return null;
  if (access.capabilities.length > CAPABILITIES.size || !access.capabilities.every((entry) => CAPABILITIES.has(entry as string))) return null;
  return { visibility: access.visibility as GitHubVisibility, capabilities: [...new Set(access.capabilities as GitHubCapability[])] };
}

function parseStatus(answer: Json): GitHubStatus | null {
  if (!CONNECTIONS.has(answer.connection as string)) return null;
  const repository = answer.repository === null || answer.repository === undefined ? null : parseAccess(answer.repository);
  if (answer.repository !== null && answer.repository !== undefined && !repository) return null;
  return { connection: answer.connection as GitHubConnection, repository };
}

function parseIssue(value: unknown): TaskIssue | null {
  const issue = record(value);
  const hidden = record(issue?.hiddenComments);
  if (!issue || !hidden) return null;
  const { number, title, body, digest, taskId } = issue;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > MAX_NUMBER) return null;
  if (typeof title !== "string" || title.length > LIMITS.title || typeof body !== "string" || body.length > LIMITS.body) return null;
  if (typeof issue.bodyTruncated !== "boolean" || typeof issue.tooLong !== "boolean" || !count(issue.characters, Number.MAX_SAFE_INTEGER)) return null;
  if (!ASSOCIATIONS.has(issue.authorAssociation as string) || !nullableTime(issue.updatedAt)) return null;
  if (typeof digest !== "string" || !DIGEST.test(digest) || (taskId !== null && (typeof taskId !== "string" || !TASK_ID.test(taskId)))) return null;
  if (!count(hidden.count, Number.MAX_SAFE_INTEGER) || !Array.isArray(hidden.ranges) || hidden.ranges.length > LIMITS.ranges) return null;
  const ranges: { start: number; end: number }[] = [];
  let previousEnd = 0;
  for (const entry of hidden.ranges) {
    const range = record(entry);
    // Ranges are ordered, do not overlap, and stay inside the served body.
    if (!range || !count(range.start, body.length) || !count(range.end, body.length) || range.start < previousEnd || range.end <= range.start) return null;
    ranges.push({ start: range.start, end: range.end });
    previousEnd = range.end;
  }
  return {
    number, title, body, bodyTruncated: issue.bodyTruncated, hiddenComments: { count: hidden.count, ranges }, characters: issue.characters,
    tooLong: issue.tooLong, authorAssociation: issue.authorAssociation as IssueAuthorAssociation, updatedAt: issue.updatedAt, digest, taskId,
  };
}

function parseList(answer: Json): TaskIssueList | null {
  if (!LIST_STATUSES.has(answer.status as string) || !Array.isArray(answer.issues) || answer.issues.length > LIMITS.issues) return null;
  const issues: TaskIssue[] = [];
  for (const entry of answer.issues) {
    const issue = parseIssue(entry);
    if (!issue) return null;
    issues.push(issue);
  }
  return { status: answer.status as IssueListStatus, readAt: nullableTime(answer.readAt) ? answer.readAt ?? null : null, truncated: answer.truncated === true, issues: answer.status === "ok" ? issues : [] };
}

/** The connection and this repository's access. An explicit desktop action: the monitor asks the GitHub CLI. */
export function readGitHubStatus(repositoryId: string): Promise<TaskIssueResult<GitHubStatus>> {
  return call(repositoryId, "status", {}, parseStatus);
}

/** Reads the repository's open issues again. Call it only on an explicit action (opening the page, Refresh). */
export function listTaskIssues(repositoryId: string): Promise<TaskIssueResult<TaskIssueList>> {
  return call(repositoryId, "list", {}, parseList);
}

/**
 * Promotes one issue into a task in the first column, by number and the digest of the version shown. The monitor
 * reads the issue again: `conflict` means it changed or is already promoted, `limit` that its text is too long.
 */
export function promoteTaskIssue(repositoryId: string, issue: { number: number; digest: string }): Promise<TaskIssueResult<{ taskId: string }>> {
  return call(repositoryId, "promote", { number: issue.number, digest: issue.digest }, (answer) =>
    typeof answer.taskId === "string" && TASK_ID.test(answer.taskId) ? { taskId: answer.taskId } : null);
}

/** Opens the GitHub CLI's own sign-in in a terminal, after a native confirmation. Never throws. */
export async function signInToGitHub(repositoryId: string): Promise<GitHubSignInStatus> {
  const result = await call(repositoryId, "sign_in", {}, (answer) =>
    typeof answer.status === "string" && SIGN_IN_STATUSES.has(answer.status) ? answer.status as GitHubSignInStatus : null);
  return result.ok ? result.value : "unavailable";
}
