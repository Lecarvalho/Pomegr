import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RepositoryDetailView } from "../../components/repositories/RepositoryDetailView";
import { repositoryRouteId, repositoryRouteOptions, type RepositorySearchParams } from "../../components/repositories/repository-route";

export const metadata: Metadata = { title: "Repository · Pomegr" };

export default async function RepositoryPage({ params, searchParams }: {
  params: Promise<{ repositoryId: string }>;
  searchParams: Promise<RepositorySearchParams>;
}) {
  const repositoryId = repositoryRouteId((await params).repositoryId);
  if (!repositoryId) notFound();
  return <RepositoryDetailView key={repositoryId} repositoryId={repositoryId} {...repositoryRouteOptions(await searchParams)} />;
}
