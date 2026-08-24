import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const sessionId = requestUrl.searchParams.get("sessionId") || "";
  const agentId = requestUrl.searchParams.get("agentId") || "";
  if (!sessionId || !agentId || sessionId.length > 256 || agentId.length > 256) {
    return Response.json({ error: "A valid session and agent are required." }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const monitorParams = new URLSearchParams({ sessionId, agentId });
  return proxyMonitorJson({
    path: `/api/transcript-path?${monitorParams}`,
    timeoutMs: 7500,
    unavailableBody: { error: "Transcript path unavailable." },
  });
}
