const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const SERVED_READINESS = new Set(["ready", "loading", "unavailable"]);
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function emptyBoard(readiness, repositoryId) {
  return {
    version: 1, readiness, repositoryId,
    columns: [], features: [], tasks: [],
    queue: { status: "idle", blockedBy: null },
  };
}

// The store validated every record; the route only pins the contract's top-level keys and the requested ID.
function projectBoard(repositoryId, board) {
  if (!board || typeof board !== "object" || !SERVED_READINESS.has(board.readiness)
    || !Array.isArray(board.columns) || !Array.isArray(board.features) || !Array.isArray(board.tasks)
    || !board.queue || typeof board.queue !== "object") {
    throw new TypeError("Task board unavailable");
  }
  return {
    version: 1, readiness: board.readiness, repositoryId,
    columns: board.columns, features: board.features, tasks: board.tasks, queue: board.queue,
  };
}

/**
 * Committed-store task board GET. `authorized` is the same-computer decision the request handler
 * shares with `GET /api/provider-folders`; a denied client learns nothing beyond `desktop_only`.
 * The route never acquires provider evidence and has no write path.
 */
export function serveTaskRoute({ request, response, requestUrl, taskStore, authorized }) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return;
  }
  const requestedId = requestUrl.searchParams.get("repositoryId") || "";
  const repositoryId = REPOSITORY_ID_PATTERN.test(requestedId) ? requestedId : "";
  if (!authorized) {
    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify(emptyBoard("desktop_only", repositoryId)));
    return;
  }
  const validQuery = [...requestUrl.searchParams.keys()].every((key) => key === "repositoryId"
    && requestUrl.searchParams.getAll(key).length === 1)
    && repositoryId !== ""
    && !(Number(request.headers["content-length"] || 0) > 0) && request.headers["transfer-encoding"] === undefined;
  if (!validQuery) {
    response.writeHead(400, JSON_HEADERS);
    response.end(JSON.stringify({ error: "Invalid tasks query" }));
    return;
  }
  try {
    const board = projectBoard(repositoryId, taskStore?.readBoard(repositoryId));
    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify(board));
  } catch {
    // A missing store or a throwing read is unavailable, never an empty ready board.
    response.writeHead(503, JSON_HEADERS);
    response.end(JSON.stringify(emptyBoard("unavailable", repositoryId)));
  }
}
