import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RepositoriesView } from "../components/command-center/CommandViews";
import { repositoryRouteId, repositoryRouteOptions, type RepositorySearchParams } from "../components/repositories/repository-route";

export const metadata: Metadata = { title: "Repositories · Pomegr", description: "Projects associated with observed Pomegr sessions." };

export default async function RepositoriesPage({ searchParams }: { searchParams: Promise<RepositorySearchParams & { repository?: string | string[] }> }) {
  const search = await searchParams;
  const repositoryId = repositoryRouteId(search.repository);
  if (repositoryId) {
    const { initialProvider, initialRevisionId } = repositoryRouteOptions(search);
    const query = new URLSearchParams({ tab: "inventory" });
    if (initialProvider) query.set("provider", initialProvider);
    if (initialRevisionId) query.set("revision", initialRevisionId);
    redirect(`/repositories/${repositoryId}?${query}`);
  }
  return <RepositoriesView />;
}
