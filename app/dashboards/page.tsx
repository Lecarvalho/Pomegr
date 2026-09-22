import { redirect } from "next/navigation";

/** Legacy destination retained only so saved local and paired-LAN links reach Home. */
export default function DashboardsPage() {
  redirect("/");
}
