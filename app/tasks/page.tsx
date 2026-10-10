import type { Metadata } from "next";
import { TasksPage } from "../components/tasks/TasksPage";
import { repositoryRouteId } from "../components/repositories/repository-route";

export const metadata: Metadata = { title: "Tasks · Pomegr", description: "Repository task boards." };

export default async function TasksRoute({ searchParams }: { searchParams: Promise<{ repository?: string | string[] }> }) {
  const { repository } = await searchParams;
  return <TasksPage initialRepositoryId={repositoryRouteId(repository)} />;
}
