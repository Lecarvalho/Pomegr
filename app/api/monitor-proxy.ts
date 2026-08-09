const MONITOR_ORIGIN = "http://127.0.0.1:4317";

type MonitorProxyOptions = {
  path: string;
  timeoutMs: number;
  unavailableBody: object;
};

export async function proxyMonitorJson({ path, timeoutMs, unavailableBody }: MonitorProxyOptions) {
  try {
    const response = await fetch(`${MONITOR_ORIGIN}${path}`, {
      cache: "no-store",
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
