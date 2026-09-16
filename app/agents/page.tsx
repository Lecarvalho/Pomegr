import type { Metadata } from "next";
import { AgentsView } from "../components/agents/AgentsView";

export const metadata: Metadata = { title: "Agents · Pomegr", description: "Agent evidence across Pomegr sessions." };

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ model?: string | string[] }> }) {
  const { model } = await searchParams;
  const candidate = Array.isArray(model) ? model[0] : model;
  const initialModel = typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128 && !/[\u0000-\u001f\u007f]/.test(candidate) ? candidate : null;
  return <AgentsView key={initialModel || "all"} initialModel={initialModel} />;
}
