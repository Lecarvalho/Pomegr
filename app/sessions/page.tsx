import type { Metadata } from "next";
import { SessionsView } from "../components/command-center/CommandViews";

export const metadata: Metadata = { title: "Sessions · Pomegr", description: "Live and historical Pomegr sessions." };

export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const { project } = await searchParams;
  const initialProject = typeof project === "string" && project.length <= 128 && !/[\\/\u0000-\u001f\u007f]/.test(project) ? project : "";
  return <SessionsView key={initialProject} initialProject={initialProject} />;
}
