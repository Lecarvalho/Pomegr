// The Tasks home: `GET /api/tasks?view=home`, gated like the board read in `task-routes.mjs`.
// The bounds repeat `server/tasks/task-home.mjs`, which this layer may not import.

const BOARD_LIMIT = 200;
const ATTENTION_LIMIT = 50;
const TITLE_LENGTH = 160;
const COLUMN_COUNT = 5;
const ATTENTION_STATES = Object.freeze(["needs_review", "stalled", "blocked"]);
const QUEUE_STATUSES = Object.freeze(["idle", "running", "blocked", "paused"]);
const PAUSE_REASONS = Object.freeze(["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked", "worktree_dirty"]);
const TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const emptyHome = (readiness) => ({ version: 1, readiness, boards: [], attention: [], attentionTotal: 0 });
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export const isTaskHomeRequest = (requestUrl) => requestUrl.searchParams.getAll("view").join() === "home";

function projectBoard(board) {
  if (!isPlainObject(board) || typeof board.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(board.repositoryId)) return null;
  const queue = board.queue;
  const ready = board.readiness === "ready" && Array.isArray(board.counts) && board.counts.length === COLUMN_COUNT && board.counts.every(count)
    && count(board.openFeatures) && isPlainObject(queue) && QUEUE_STATUSES.includes(queue.status)
    && (board.updatedAt === null || (typeof board.updatedAt === "string" && INSTANT_PATTERN.test(board.updatedAt)));
  if (!ready) return { repositoryId: board.repositoryId, readiness: "unavailable", counts: [], openFeatures: 0, queue: { status: "idle", blockedBy: null, pauseReason: null }, updatedAt: null };
  return {
    repositoryId: board.repositoryId, readiness: "ready", counts: [...board.counts], openFeatures: board.openFeatures,
    queue: {
      status: queue.status,
      blockedBy: typeof queue.blockedBy === "string" && TASK_ID_PATTERN.test(queue.blockedBy) ? queue.blockedBy : null,
      pauseReason: queue.status === "paused" && PAUSE_REASONS.includes(queue.pauseReason) ? queue.pauseReason : null,
    },
    updatedAt: board.updatedAt,
  };
}

function projectAttention(item) {
  return isPlainObject(item) && typeof item.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(item.repositoryId)
    && typeof item.taskId === "string" && TASK_ID_PATTERN.test(item.taskId) && ATTENTION_STATES.includes(item.state)
    && typeof item.title === "string" && item.title.length <= TITLE_LENGTH && !LINE_CONTROL.test(item.title)
    ? { repositoryId: item.repositoryId, taskId: item.taskId, title: item.title, state: item.state }
    : null;
}

// Only the contract keys of what the store answered are served.
function projectHome(home) {
  if (!isPlainObject(home) || !Array.isArray(home.boards) || !Array.isArray(home.attention) || !count(home.attentionTotal)) throw new TypeError("Task home unavailable");
  const boards = home.boards.slice(0, BOARD_LIMIT).map(projectBoard).filter((board) => board !== null);
  const attention = home.attention.slice(0, ATTENTION_LIMIT).map(projectAttention).filter((item) => item !== null);
  return { version: 1, readiness: "ready", boards, attention, attentionTotal: Math.max(home.attentionTotal, attention.length) };
}

export function serveTaskHomeRoute({ request, response, requestUrl, taskStore, authorized, resolveSessionFacts = null }) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return;
  }
  if (!authorized) {
    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify(emptyHome("desktop_only")));
    return;
  }
  const validQuery = [...requestUrl.searchParams.keys()].join() === "view"
    && !(Number(request.headers["content-length"] || 0) > 0) && request.headers["transfer-encoding"] === undefined;
  if (!validQuery) {
    response.writeHead(400, JSON_HEADERS);
    response.end(JSON.stringify({ error: "Invalid tasks query" }));
    return;
  }
  try {
    const home = projectHome(taskStore?.readHome({ resolveSessionFacts }));
    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify(home));
  } catch {
    // A missing store or a throwing read is unavailable, never an empty ready home.
    response.writeHead(503, JSON_HEADERS);
    response.end(JSON.stringify(emptyHome("unavailable")));
  }
}
