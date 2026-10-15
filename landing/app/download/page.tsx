import type { Metadata } from "next";
import { SiteHeader } from "../components/SiteHeader";
import { SiteFooter } from "../components/SiteFooter";
import { formatDownloadSize, getDownloadRelease } from "../../server/download-release";
import styles from "./DownloadPage.module.css";

export const metadata: Metadata = {
  title: "Download Pomegr for Windows",
  description: "Download Pomegr for Windows x64 for free: the installer that keeps itself up to date, or the portable app that runs without installation.",
  alternates: { canonical: "/download" },
};

export default async function DownloadPage() {
  const release = await getDownloadRelease();
  const { installer, portable } = release;

  return (
    <main className={styles.download}>
      <SiteHeader current="download" />
      <div className={styles.page}>
        <section className={styles.hero} aria-labelledby="download-title">
          <h1 id="download-title">Get Pomegr on your machine. <span>Free, and it keeps itself up to date.</span></h1>
          <p>Free for Windows x64. No account, and your session data stays on this device.</p>
        </section>

        <div className={styles.sheetWrap}>
          <div className={styles.fruit} aria-hidden="true">
            <img src="/landing/download/pomegranate-half.png" alt="" width="600" height="476" />
          </div>
          <section className={styles.sheet} aria-label="Choose a Windows x64 build">
            <span className={styles.ticks} aria-hidden="true" />
            <div className={styles.sheetHead}>
              <span className={styles.label}>[ fig. 1 — two builds, one observer ]</span>
              <span className={`${styles.label} ${styles.quiet}`}>Windows x64 · v{release.version}</span>
            </div>
            <div className={styles.columns}>
              <article className={`${styles.column} ${styles.recommended}`} aria-labelledby="installer-title">
                <span className={styles.label}>Installer · recommended</span>
                <h2 id="installer-title">Installs and keeps itself up to date.</h2>
                <dl className={styles.spec}>
                  <div className={styles.on}><dt className={styles.label}>Updates</dt><dd>Automatic. Checks at startup and every four hours, and installs when you choose to restart.</dd></div>
                  <div><dt className={styles.label}>Installs</dt><dd>For your Windows user, no admin needed</dd></div>
                  <div><dt className={styles.label}>At login</dt><dd>Optional, from the tray menu</dd></div>
                </dl>
                <div className={styles.get}>
                  <a className={styles.action} href={installer.url}>Download installer <DownloadIcon /></a>
                  <p className={styles.label}>{installer.name} · {formatDownloadSize(installer.size)} · v{release.version}</p>
                </div>
              </article>
              <article className={`${styles.column} ${styles.alternative}`} aria-labelledby="portable-title">
                <span className={styles.label}>Portable</span>
                <h2 id="portable-title">Runs without installation.</h2>
                <dl className={styles.spec}>
                  <div><dt className={styles.label}>Updates</dt><dd>Manual. Download each new version yourself.</dd></div>
                  <div><dt className={styles.label}>Installs</dt><dd>Nothing; run it from any writable folder</dd></div>
                  <div><dt className={styles.label}>Data</dt><dd><code>PomegrData</code>, beside the executable</dd></div>
                </dl>
                <div className={styles.get}>
                  <a className={styles.textLink} href={portable.url}>Download portable <span aria-hidden="true">↓</span></a>
                  <p className={styles.label}>{portable.name} · {formatDownloadSize(portable.size)} · v{release.version}</p>
                </div>
              </article>
            </div>
            <div className={styles.sheetFoot}>
              <span className={styles.label}>Free · same read-only observer in both · processing stays local</span>
              <a className={styles.textLink} href={release.notesUrl} target="_blank" rel="noreferrer">Release notes and checksums <span aria-hidden="true">↗</span></a>
            </div>
          </section>
        </div>
      </div>
      <SiteFooter current="download" />
    </main>
  );
}

function DownloadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 19h14" /></svg>;
}
