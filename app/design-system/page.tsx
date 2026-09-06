import type { Metadata } from "next";
import { DesignSystemView } from "../components/design-system/DesignSystemView";
import "../styles/design-system.css";

export const metadata: Metadata = {
  title: "Design system · Pomegr",
  description: "Web-only reference of the Pomegr control roles, chips, panels, and tokens rendered from the real application classes.",
};

// Web-only reference. It is deliberately absent from navigation, the LAN gateway
// allowlist, and the desktop shell (see desktop/security-policy.mjs hidden paths).
export default function DesignSystemPage() { return <DesignSystemView />; }
