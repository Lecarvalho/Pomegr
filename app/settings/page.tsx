import type { Metadata } from "next";
import { SettingsPage } from "./SettingsPage";

export const metadata: Metadata = {
  title: "Settings · Pomegr",
  description: "Choose which session evidence Pomegr displays.",
};

export default function Page() {
  return <SettingsPage />;
}
