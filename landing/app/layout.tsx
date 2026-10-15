import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const description = "A quiet, local observer for coding-agent sessions. Available now for Windows x64.";
const socialTitle = "Pomegr — Keep your bearings while agents work";
const socialDescription =
  "See live activity, context, tasks, Git changes, and usage in one read-only operations view. Download for Windows x64.";
const socialImage = {
  url: "/landing/social/pomegr-og-inclined-quiet-observer.png",
  width: 1200,
  height: 630,
  alt: "Pomegr — A quiet, local observer for coding-agent sessions",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://pomegr.com"),
  title: { default: "Pomegr", template: "%s · Pomegr" },
  description,
  icons: {
    icon: [
      { url: "/favicon.ico?v=painted-1", sizes: "16x16 32x32 48x48 256x256" },
      { url: "/favicon.png?v=painted-1", type: "image/png", sizes: "64x64" },
    ],
    shortcut: "/favicon.ico?v=painted-1",
  },
  openGraph: {
    type: "website",
    siteName: "Pomegr",
    title: socialTitle,
    description: socialDescription,
    url: "https://pomegr.com",
    images: [socialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: socialTitle,
    description: socialDescription,
    images: [socialImage],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
