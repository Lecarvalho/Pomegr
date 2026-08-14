import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://pomegr.com"),
  title: { default: "Pomegr", template: "%s · Pomegr" },
  description: "A quiet, local observer for coding-agent sessions.",
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }] },
  openGraph: {
    type: "website",
    siteName: "Pomegr",
    title: "Pomegr",
    description: "A quiet, local observer for coding-agent sessions.",
    url: "https://pomegr.com",
  },
};

const designContract = `
THESIS: Pomegr turns an invisible agent session into a legible operations wall; it refuses the centered SaaS hero and floating feature-card grid.
OWN-WORLD: Warm drafting paper, a near-black monitor field, pomegranate-red stamps, acid-green live signals, thin ink rules, field notes, and the existing Pomegr logo.
STORY: See one live session branch into context, tasks, Git, and usage; understand the local read-only boundary; join the platform waitlist or use the repository now.
FIRST VIEWPORT: A slim paper header sits over a dark observer canvas taking most of the fold; a torn-paper headline and primary action overlap its lower-left edge.
FORM: Immersive operations wall, the approved sixth grounded direction, seed 65230478.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
`.trim();

const contractBootScript = `
  try {
    document.body.insertBefore(document.createComment(${JSON.stringify(designContract)}), document.body.firstChild);
  } catch {}
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${geistMono.variable}`}>
        <script dangerouslySetInnerHTML={{ __html: contractBootScript }} />
        {children}
      </body>
    </html>
  );
}
