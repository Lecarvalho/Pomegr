const DEFAULT_MONITOR_ORIGIN = "http://127.0.0.1:4317";

export function monitorOrigin(value = process.env.POMEGR_MONITOR_ORIGIN) {
  if (!value) return DEFAULT_MONITOR_ORIGIN;
  try {
    const origin = new URL(value);
    if (origin.protocol !== "http:" || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash || !origin.port
      || !["127.0.0.1", "[::1]"].includes(origin.hostname)) {
      return DEFAULT_MONITOR_ORIGIN;
    }
    return origin.origin;
  } catch {
    return DEFAULT_MONITOR_ORIGIN;
  }
}

type MonitorProxyOptions = {
  path: string;
  timeoutMs: number;
  unavailableBody: object;
};

export async function proxyMonitorJson({ path, timeoutMs, unavailableBody }: MonitorProxyOptions) {
  try {
    const authorizationToken = process.env.POMEGR_MONITOR_TOKEN;
    const response = await fetch(`${monitorOrigin()}${path}`, {
      cache: "no-store",
      headers: authorizationToken
        ? { "x-pomegr-desktop-authorization": authorizationToken }
        : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Monitor returned ${response.status}`);
    return new Response(await response.text(), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(unavailableBody, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
