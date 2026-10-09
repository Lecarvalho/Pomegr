import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

function isLoopbackHost(value: string | null) {
  if (!value) return false;
  try {
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(`http://${value}`).hostname);
  } catch { return false; }
}

// The same-computer test of app/api/tasks/route.ts (its helpers are route-private). Unlike /api/tasks, this path is
// forwarded by the LAN gateway, which rewrites the host to loopback: the gateway marks every request it forwards, and
// a marked request is never a same-computer one.
function isSameComputerRequest(request: Request, url: URL) {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return !request.headers.has("x-pomegr-lan-gateway") && isLoopbackHost(host) && host === url.host
    && (origin === null || origin === url.origin)
    && (fetchSite === null || fetchSite === "same-origin");
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const monitorParams = new URLSearchParams();
  // This route intentionally forwards only the bounded catalog query vocabulary.  The
  // monitor owns validation and cursor binding, but preserving this small allowlist
  // prevents the browser proxy from becoming a generic loopback query relay.
  for (const key of ["mode", "query", "filter", "project", "repositoryId", "provider", "group", "feature", "pageSize", "cursor", "revision", "selected", "pinned"]) {
    const value = requestUrl.searchParams.get(key);
    if (value !== null && value !== "") monitorParams.set(key, value);
  }
  // A session's task reference and the feature scope are task-board content, served like GET /api/tasks: to a
  // same-computer client only. The marker is set here and never copied from the request, so a LAN client gets the
  // list without task references and its feature scope answers `taskReadiness: "desktop_only"` with no session.
  if (monitorParams.get("mode") === "directory" && isSameComputerRequest(request, requestUrl)) monitorParams.set("tasks", "1");
  return proxyMonitorJson({
    ifNoneMatch: request.headers.get("if-none-match"),
    acceptEncoding: request.headers.get("accept-encoding"),
    path: `/api/sessions${monitorParams.size ? `?${monitorParams}` : ""}`,
    timeoutMs: 7500,
    unavailableBody: { sessions: [], error: "Historical sessions are unavailable." },
  });
}
