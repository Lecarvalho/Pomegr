import { proxyMonitorJson } from "../monitor-proxy";

export const dynamic = "force-dynamic";

const unavailable = { folders: { claudeConfigDir: null, claudeProjectsDir: null, codexHome: null } };

function isLoopbackHost(value: string | null) {
  if (!value) return false;
  try {
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(`http://${value}`).hostname);
  } catch { return false; }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (request.method !== "GET" || url.search || Number(request.headers.get("content-length") || 0) > 0
    || request.headers.has("transfer-encoding") || !isLoopbackHost(host) || host !== url.host
    || origin !== null && origin !== url.origin
    || fetchSite !== null && fetchSite !== "same-origin") {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return proxyMonitorJson({ path: "/api/provider-folders", timeoutMs: 7500, unavailableBody: unavailable });
}
