import type { Metadata } from "next";
import { RepositoriesView } from "../components/command-center/CommandViews";

export const metadata: Metadata = { title: "Repositories · Pomegr", description: "Projects associated with observed Pomegr sessions." };

export default function RepositoriesPage() { return <RepositoriesView />; }
