import { monitorOrigin } from "../monitor-proxy";
import { normalizeRendererTracePayload } from "../../../shared/renderer-trace-contract.mjs";

export const dynamic = "force-dynamic";

function loopbackHost(value: string | null) {
  if (!value) return false;
  try { return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(`http://${value}`).hostname); } catch { return false; }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (url.search || !loopbackHost(host) || host !== url.host || request.headers.get("origin") !== url.origin
    || request.headers.get("sec-fetch-site") !== "same-origin" || request.headers.get("content-type") !== "application/json"
    || request.headers.has("transfer-encoding") || Number(request.headers.get("content-length") || 0) > 8_192) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  let payload;
  try { payload = normalizeRendererTracePayload(await request.json()); } catch { payload = null; }
  if (!payload) return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    const token = process.env.POMEGR_MONITOR_TOKEN;
    const response = await fetch(`${monitorOrigin()}/internal/renderer-trace`, {
      method: "POST", cache: "no-store", body: JSON.stringify(payload), signal: AbortSignal.timeout(2_000),
      headers: { "content-type": "application/json", ...(token ? { "x-pomegr-desktop-authorization": token } : {}) },
    });
    return new Response(null, { status: response.ok ? 204 : 503, headers: { "Cache-Control": "no-store" } });
  } catch { return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
