export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const response = await fetch("http://127.0.0.1:4317/api/sessions", {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
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
    return Response.json(
      { sessions: [], error: "Historical sessions are unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
