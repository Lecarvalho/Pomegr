import type { Metadata } from "next";
import { Dashboard } from "./Dashboard";

export const metadata: Metadata = {
  title: "Pomegr",
  description: "A quiet, local observer for coding-agent sessions.",
};

export default function Home() {
  return <Dashboard />;
}
