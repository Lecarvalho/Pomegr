import type { Metadata } from "next";
import { HomeDashboard } from "./HomeDashboard";

export const metadata: Metadata = {
  title: "Pomegr",
  description: "A quiet, local observer for coding-agent sessions.",
};

export default function Home() {
  return <HomeDashboard />;
}
