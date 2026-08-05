export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const refreshUsage = requestUrl.searchParams.get("refreshUsage") === "1";
    const sessionId = requestUrl.searchParams.get("sessionId") || "";
    const monitorParams = new URLSearchParams();
    if (refreshUsage) monitorParams.set("refreshUsage", "1");
    if (sessionId) monitorParams.set("sessionId", sessionId);
    const monitorUrl = `http://127.0.0.1:4317/api/state${monitorParams.size ? `?${monitorParams}` : ""}`;
    const response = await fetch(monitorUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(refreshUsage ? 7500 : sessionId ? 5000 : 1500),
    });

    if (!response.ok) {
      throw new Error(`Monitor returned ${response.status}`);
    }

    return new Response(await response.text(), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      {
        connected: false,
        source: "Claude Code",
        view: "live",
        session: null,
        score: 100,
        metrics: {
          agents: 0,
          activeAgents: 0,
          toolCalls: 0,
          repeatedCalls: 0,
          tokens: { total: 0, cumulative: 0, allAgents: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, lastMinute: 0 },
        },
        agents: [],
        toolPatterns: [],
        loops: [],
        activity: [],
        insights: [],
        usageLimits: { available: false, fetchedAt: null, limits: [], error: "Usage limits are unavailable." },
        error: "The local session monitor is unavailable.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
