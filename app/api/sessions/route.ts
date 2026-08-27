import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return proxyMonitorJson({
    path: "/api/sessions",
    timeoutMs: 7500,
    unavailableBody: { sessions: [], liveSessions: [], error: "Historical sessions are unavailable." },
  });
}
