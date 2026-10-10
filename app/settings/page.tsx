import type { Metadata } from "next";
import { SettingsPage } from "./SettingsPage";

export const metadata: Metadata = {
  title: "Settings · Pomegr",
  description: "Choose which session evidence Pomegr displays.",
};

const OPENABLE_SECTIONS = ["providers", "github", "storage", "about"] as const;

export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const { section } = await searchParams;
  const initialSection = OPENABLE_SECTIONS.find((id) => id === section) ?? "appearance";
  return <SettingsPage key={initialSection} initialSection={initialSection} />;
}
