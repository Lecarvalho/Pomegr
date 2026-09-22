import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Dashboard } from "../../Dashboard";
import { decodeSessionRoute } from "../../../shared/session-route.mjs";

export const metadata: Metadata = {
  title: "Session · Pomegr",
};

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sessionId } = await params;
  const query = await searchParams;
  const initialSessionId = decodeSessionRoute(sessionId);
  if (!initialSessionId) notFound();
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  return <Dashboard key={initialSessionId} initialSessionId={initialSessionId} initialQuery={{
    tab: first(query.tab), agent: first(query.agent), request: first(query.request), path: first(query.path),
  }} />;
}
