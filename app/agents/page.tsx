import type { Metadata } from "next";
import { AgentsView } from "../components/command-center/CommandViews";

export const metadata: Metadata = { title: "Agents · Pomegr", description: "Agent evidence across Pomegr sessions." };

export default function AgentsPage() { return <AgentsView />; }
