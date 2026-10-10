import type { Metadata } from "next";
import { PromoteIssuesMissing, PromoteIssuesView } from "../../components/tasks/PromoteIssuesView";
import { repositoryRouteId } from "../../components/repositories/repository-route";

export const metadata: Metadata = { title: "Promote issues · Pomegr", description: "Choose a GitHub issue to promote into a task." };

export default async function PromoteIssuesRoute({ searchParams }: { searchParams: Promise<{ repository?: string | string[] }> }) {
  const { repository } = await searchParams;
  const repositoryId = repositoryRouteId(repository);
  // Keyed by repository, so the page state never carries over from another repository's issues.
  return repositoryId ? <PromoteIssuesView key={repositoryId} repositoryId={repositoryId} /> : <PromoteIssuesMissing />;
}
