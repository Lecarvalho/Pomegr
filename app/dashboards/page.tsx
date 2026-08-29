import type { Metadata } from "next";
import { DashboardsView } from "../components/command-center/CommandViews";

export const metadata: Metadata = { title: "Dashboards · Pomegr", description: "Built-in Pomegr workspace dashboards." };

export default function DashboardsPage() { return <DashboardsView />; }
