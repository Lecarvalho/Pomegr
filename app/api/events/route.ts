import { proxyMonitorEventStream } from "../monitor-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxyMonitorEventStream(request.signal);
}
