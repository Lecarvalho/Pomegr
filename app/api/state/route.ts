export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const response = await fetch("http://127.0.0.1:4317/api/state", {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
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
        activity: [],
        insights: [],
        usageLimits: { available: false, fetchedAt: null, limits: [], error: "Usage limits are unavailable." },
        error: "The local session monitor is unavailable.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
