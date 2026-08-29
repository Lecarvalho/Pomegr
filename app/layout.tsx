import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import localFont from "next/font/local";
import { AppShell } from "./components/AppShell";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const rokkitt = localFont({
  src: "../landing/public/fonts/rokkitt-variable.ttf",
  variable: "--font-rokkitt",
  weight: "400 900",
});

export const metadata: Metadata = {
  title: "Pomegr",
  description: "A quiet, local observer for coding-agent sessions.",
  icons: {
    icon: [{ url: "/pomegr-logo.png", type: "image/png" }],
    shortcut: "/pomegr-logo.png",
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
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootScript }} /></head>
      <body
        className={`${inter.variable} ${geistMono.variable} ${rokkitt.variable} antialiased`}
      >
        <div hidden dangerouslySetInnerHTML={{ __html: `<!--
THESIS: Pomegr is one focused Command Center, not a collection of page-local dashboards and utility drawers.
OWN-WORLD: Near-black operational surfaces, pomegranate wordmark, semantic green/amber/lavender evidence, one-pixel rules, and precise slab-plus-sans-plus-mono typography.
STORY: Developers move from workspace state to sessions, agents, usage, repositories, settings, and safe local notifications without losing monitoring context.
FIRST VIEWPORT: A compact global header sits above a 220px route rail, live evidence workspace, non-modal right notification drawer, and persistent read-only footer.
FORM: The approved Command Center, selected from three professional shell structures; seed f4dae4f2.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->` }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
