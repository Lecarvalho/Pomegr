import type { Metadata } from "next";
import { SiteHeader } from "../components/SiteHeader";
import { SiteFooter } from "../components/SiteFooter";
import { formatDownloadSize, getDownloadRelease } from "../../server/download-release";
import shared from "../components/LandingPage.module.css";
import styles from "./DownloadPage.module.css";

export const metadata: Metadata = {
  title: "Download Pomegr for Windows",
  description: "Download the Pomegr Windows x64 installer with in-app updates, or the portable app that runs without installation.",
  alternates: { canonical: "/download" },
};

export default async function DownloadPage() {
  const release = await getDownloadRelease();
  const options = [
    { id: "installer", label: "Installer", code: "SETUP", heading: "Installs and self-updates.",
      facts: ["Installs Pomegr into Windows", "Supports in-app updates"], asset: release.installer },
    { id: "portable", label: "Portable", code: "PORTABLE", heading: "Runs without installation.",
      facts: ["Nothing to install", "Download and run the executable"], asset: release.portable },
  ];

  return (
    <main className={`${shared.landing} ${styles.page}`}>
      <div className={`${shared.printMarks} ${styles.printMarks}`} aria-hidden="true"><i /><i /><i /><i /></div>
      <SiteHeader current="download" />
      <section className={styles.download} aria-labelledby="download-title">
        <div className={styles.intro}>
          <h1 id="download-title">Get Pomegr on your <em>machine.</em></h1>
          <p>Two ways to run the same read-only observer. Pick one.<br />Your session data stays on this device either way.</p>
        </div>
        <div className={styles.options}>
          {options.map((option, index) => (
            <article key={option.id} className={`${shared.waitlistTicket} ${styles.ticket}`} aria-labelledby={`${option.id}-title`}>
              <div className={`${shared.ticketTopline} ${styles.topline}`}>
                <span>Option {index + 1} · {option.label}</span><span>PMGR / {option.code}</span>
              </div>
              <div className={styles.ticketHeading}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  {option.id === "installer"
                    ? <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 8v6M9 11l3 3 3-3M7 17h10" /></>
                    : <path d="M4 8h16v11H4zM8 8V5h8v3M10 13h4" />}
                </svg>
                <h2 id={`${option.id}-title`}>{option.heading}</h2>
              </div>
              <ul className={styles.ticketFacts}>
                {option.facts.map((fact) => <li key={fact}>{fact}</li>)}
              </ul>
              <div className={styles.ticketAction}>
                <a className={shared.primaryAction} href={option.asset.url}>
                  Download {option.id}<DownloadIcon />
                </a>
                <p className={styles.fileMeta}>{option.asset.name} · {formatDownloadSize(option.asset.size)} · v{release.version}</p>
              </div>
            </article>
          ))}
        </div>
        <div className={styles.assurance}>
          <p>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="1" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>
            <span>Both builds are the same read-only observer for Windows x64. No Pomegr account required. Session processing stays local.</span>
          </p>
          <a href={release.notesUrl} target="_blank" rel="noreferrer">Release notes and checksums on GitHub
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
          </a>
        </div>
      </section>
      <SiteFooter current="download" />
    </main>
  );
}

function DownloadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>;
}
