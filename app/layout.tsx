import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { AppShell } from "./components/AppShell";
import { ClientAccessProvider } from "./hooks/ClientAccessContext";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pomegr",
  description: "A quiet, local observer for coding-agent sessions.",
  icons: {
    icon: [
      { url: "/favicon.ico?v=painted-1", sizes: "16x16 32x32 48x48 256x256" },
      { url: "/favicon.png?v=painted-1", type: "image/png", sizes: "64x64" },
    ],
    shortcut: "/favicon.ico?v=painted-1",
  },
};

const themeBootScript = `
  try {
    const savedTheme = localStorage.getItem("pomegr-theme");
    const theme = savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : "dark";
    document.documentElement.dataset.theme = theme;
  } catch {
    document.documentElement.dataset.theme = "light";
  }
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootScript }} /></head>
      <body
        className="antialiased"
      >
        <div hidden dangerouslySetInnerHTML={{ __html: `<!--
THESIS: Pomegr makes recorded agent work legible through a calm, consistent evidence workspace.
OWN-WORLD: Charcoal and neutral light surfaces, pomegranate action accents, Inter UI, data-only Geist Mono, 4px controls and 6px panels.
STORY: Return to a session, inspect agent activity, follow actual context levels, then open supporting evidence without exposing the conversation.
FIRST VIEWPORT: A 60px global header, 220px route rail, compact sans page title, aligned actions, and primary evidence at a readable scale.
FORM: User-approved standalone HTML preview in docs/design/pomegr-ui-preview.html; production retains every real route and capability.
MOTION: Preserve the current activityPulse icon animation and its reduced-motion behavior.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->` }} />
        <ClientAccessProvider><AppShell>{children}</AppShell></ClientAccessProvider>
      </body>
    </html>
  );
}
