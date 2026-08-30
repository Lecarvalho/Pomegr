import type { Metadata } from "next";
import { HomeDashboard } from "./HomeDashboard";

export const metadata: Metadata = {
  title: "Pomegr",
  description: "Your Pomegr workspace: pinned destinations, session shortcuts, and features to explore.",
};

export default function Home() {
  return <HomeDashboard />;
}
