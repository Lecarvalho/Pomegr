import type { Metadata } from "next";
import { Dashboard } from "./Dashboard";

export const metadata: Metadata = {
  title: "Threadlight",
  description: "A quiet, local monitor for Claude Code sessions.",
};

export default function Home() {
  return <Dashboard />;
}
