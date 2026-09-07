import type { Metadata } from "next";
import { SessionsView } from "../components/command-center/CommandViews";
import { repositoryRouteId } from "../components/repositories/repository-route";

export const metadata: Metadata = { title: "Sessions · Pomegr", description: "Live and historical Pomegr sessions." };

export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ project?: string | string[]; repository?: string | string[] }> }) {
  const { project, repository } = await searchParams;
  const initialRepositoryId = repositoryRouteId(repository);
  const initialProject = typeof project === "string" && project.length <= 128 && !/[\\/\u0000-\u001f\u007f]/.test(project) ? project : "";
  return <SessionsView key={`${initialProject}:${initialRepositoryId ?? ""}`} initialProject={initialProject} initialRepositoryId={initialRepositoryId} />;
}
