import type { Metadata } from "next";
import { SessionsView } from "../components/command-center/CommandViews";

export const metadata: Metadata = { title: "Sessions · Pomegr", description: "Live and historical Pomegr sessions." };

export default function SessionsPage() { return <SessionsView />; }
