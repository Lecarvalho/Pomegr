import { createEmptyTaskBoard, createEmptyTaskHome, type TaskBoard } from "../../../shared/task-contract";
import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;

// Task text is user-authored content, so the monitor gates this read like GET /api/provider-folders.
function isLoopbackHost(value: string | null) {
  if (!value) return false;
  try {
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(`http://${value}`).hostname);
  } catch { return false; }
}

function isSameComputerRequest(request: Request, url: URL) {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return request.method === "GET" && isLoopbackHost(host) && host === url.host
    && Number(request.headers.get("content-length") || 0) === 0 && !request.headers.has("transfer-encoding")
    && (origin === null || origin === url.origin)
    && (fetchSite === null || fetchSite === "same-origin");
}

function contentFreeBoard(repositoryId: string, readiness: "unavailable" | "desktop_only"): TaskBoard {
  return createEmptyTaskBoard(repositoryId, readiness);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const supplied = url.searchParams;
  const repositoryId = supplied.get("repositoryId") || "";
  // The Tasks home: one summary of every stored board, gated like a board read.
  if (supplied.getAll("view").join() === "home") {
    if (!isSameComputerRequest(request, url)) {
      return Response.json(createEmptyTaskHome("desktop_only"), { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if ([...supplied.keys()].join() !== "view") {
      return Response.json({ error: "Invalid tasks query" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    return proxyMonitorJson({
      path: "/api/tasks?view=home",
      timeoutMs: 5_000,
      unavailableBody: createEmptyTaskHome("unavailable"),
      acceptEncoding: request.headers.get("accept-encoding"),
      ifNoneMatch: request.headers.get("if-none-match"),
    });
  }
  if (!isSameComputerRequest(request, url)) {
    return Response.json(contentFreeBoard(REPOSITORY_ID_PATTERN.test(repositoryId) ? repositoryId : "", "desktop_only"), { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const validQuery = [...supplied.keys()].every((key) => key === "repositoryId" && supplied.getAll(key).length === 1)
    && REPOSITORY_ID_PATTERN.test(repositoryId);
  if (!validQuery) {
    return Response.json({ error: "Invalid tasks query" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  return proxyMonitorJson({
    path: `/api/tasks?${new URLSearchParams({ repositoryId })}`,
    timeoutMs: 5_000,
    unavailableBody: contentFreeBoard(repositoryId, "unavailable"),
    acceptEncoding: request.headers.get("accept-encoding"),
    ifNoneMatch: request.headers.get("if-none-match"),
  });
}
