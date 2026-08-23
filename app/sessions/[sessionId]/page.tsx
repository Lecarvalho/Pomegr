import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Dashboard } from "../../Dashboard";
import { decodeSessionRoute } from "../../../shared/session-route.mjs";

export const metadata: Metadata = {
  title: "Session · Pomegr",
};

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const initialSessionId = decodeSessionRoute(sessionId);
  if (!initialSessionId) notFound();
  return <Dashboard key={initialSessionId} initialSessionId={initialSessionId} />;
}
