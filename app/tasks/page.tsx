import type { Metadata } from "next";
import { TasksPage } from "../components/tasks/TasksPage";
import { repositoryRouteId } from "../components/repositories/repository-route";
import { featureRouteId } from "../components/tasks/task-features";

export const metadata: Metadata = { title: "Tasks · Pomegr", description: "Repository task boards." };

export default async function TasksRoute({ searchParams }: { searchParams: Promise<{ repository?: string | string[]; feature?: string | string[] }> }) {
  const { repository, feature } = await searchParams;
  return <TasksPage initialRepositoryId={repositoryRouteId(repository)} initialFeatureId={featureRouteId(feature)} />;
}
