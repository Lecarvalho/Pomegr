import type { Metadata } from "next";
import { SettingsPage } from "./SettingsPage";

export const metadata: Metadata = {
  title: "Settings · Pomegr",
  description: "Choose which session evidence Pomegr displays.",
};

export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const { section } = await searchParams;
  const initialSection = section === "about" ? "about" : "appearance";
  return <SettingsPage key={initialSection} initialSection={initialSection} />;
}
