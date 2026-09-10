import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

const allowed = new Set(["sessionId", "kind", "scope", "offset", "limit", "requestId", "filterRequestId", "anchor", "overview"]);

export async function GET(request: Request) {
  const source = new URL(request.url);
  const params = new URLSearchParams();
  for (const [key, value] of source.searchParams) if (allowed.has(key)) params.append(key, value);
  const kind = params.get("kind") === "requests" ? "requests" : "activity";
  return proxyMonitorJson({
    path: `/api/session-history?${params}`,
    timeoutMs: 7500,
    unavailableBody: { status: "unavailable", kind, revision: "0", total: 0, offset: 0, items: [], linkedCount: 0 },
  });
}
