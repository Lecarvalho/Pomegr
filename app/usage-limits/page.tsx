import type { Metadata } from "next";
import { UsageLimitsView } from "../components/command-center/CommandViews";

export const metadata: Metadata = { title: "Usage limits · Pomegr", description: "Provider-reported account usage windows." };

export default function UsageLimitsPage() { return <UsageLimitsView />; }
