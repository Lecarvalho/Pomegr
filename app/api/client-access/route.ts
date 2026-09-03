export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ mode: "local", canCopyTranscriptPath: true }, {
    headers: { "Cache-Control": "no-store" },
  });
}
