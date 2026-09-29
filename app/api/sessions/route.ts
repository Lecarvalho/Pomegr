import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const monitorParams = new URLSearchParams();
  // This route intentionally forwards only the bounded catalog query vocabulary.  The
  // monitor owns validation and cursor binding, but preserving this small allowlist
  // prevents the browser proxy from becoming a generic loopback query relay.
  for (const key of ["mode", "query", "filter", "project", "repositoryId", "pageSize", "cursor", "revision", "selected", "pinned"]) {
    const value = requestUrl.searchParams.get(key);
    if (value !== null && value !== "") monitorParams.set(key, value);
  }
  return proxyMonitorJson({
    ifNoneMatch: request.headers.get("if-none-match"),
    acceptEncoding: request.headers.get("accept-encoding"),
    path: `/api/sessions${monitorParams.size ? `?${monitorParams}` : ""}`,
    timeoutMs: 7500,
    unavailableBody: { sessions: [], error: "Historical sessions are unavailable." },
  });
}
