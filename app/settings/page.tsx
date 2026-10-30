import type { Metadata } from "next";
import { repositoryRouteId } from "../components/repositories/repository-route";
import { SettingsPage } from "./SettingsPage";

export const metadata: Metadata = {
  title: "Settings · Pomegr",
  description: "Choose which session evidence Pomegr displays.",
};

const OPENABLE_SECTIONS = ["providers", "github", "aril", "storage", "about"] as const;

export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string | string[]; repository?: string | string[] }> }) {
  const { section, repository } = await searchParams;
  const initialSection = OPENABLE_SECTIONS.find((id) => id === section) ?? "appearance";
  // The repository a link names, for the section that has one; any other value is no choice.
  const initialRepositoryId = repositoryRouteId(repository) ?? null;
  return <SettingsPage key={`${initialSection}/${initialRepositoryId}`} initialSection={initialSection} initialRepositoryId={initialRepositoryId} />;
}
