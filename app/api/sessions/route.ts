import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyMonitorJson({
    path: "/api/sessions",
    timeoutMs: 4000,
    unavailableBody: { sessions: [], error: "Historical sessions are unavailable." },
  });
}
