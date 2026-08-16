import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PomegrBrand } from "../components/PomegrBrand";
import { ThemeToggle } from "../components/ThemeToggle";

export const metadata: Metadata = {
  title: "About · Pomegr",
  description: "How Pomegr observes coding-agent sessions while keeping raw conversation content private.",
};

export default function About() {
  const principles = [
    { label: "LOCAL-FIRST", title: "Your session stays local", detail: "Pomegr reads local session records and presents a normalized, read-only view." },
    { label: "CLEAR PROVENANCE", title: "Summaries stay attributed", detail: "When a provider records a session summary, Pomegr displays bounded plain text and labels where it came from." },
    { label: "DETERMINISTIC", title: "Signals are explainable", detail: "Efficiency signals come from concrete execution events and documented rules, not hidden AI judgment." },
  ];
  return (
    <main className="aboutShell">
      <header className="topbar">
        <PomegrBrand label="Pomegr dashboard" />
        <div className="topActions">
          <ThemeToggle />
          <Link className="ghostButton aboutBack" href="/">Back to dashboard</Link>
        </div>
      </header>

      <article className="aboutPage">
        <span className="aboutBrandMark" role="img" aria-label="Pomegr pomegranate mark">
          <Image className="aboutBrandMarkDark" src="/pomegr-mark-outline-dark.svg" alt="" width={64} height={64} priority />
          <Image className="aboutBrandMarkLight" src="/pomegr-mark-outline-light.svg" alt="" width={64} height={64} priority />
        </span>
        <div className="eyebrow"><span /> ABOUT POMEGR</div>
        <h1>A quiet view into active work.</h1>
        <p className="aboutLead">Observe coding-agent sessions without exposing prompts or responses. Pomegr analyzes execution metadata only.</p>

        <section className="aboutGrid" aria-label="Pomegr principles">
          {principles.map((principle) => <PrincipleCard key={principle.label} {...principle} />)}
        </section>

        <section className="aboutNote" aria-labelledby="estimated-cost-title">
          <div><span className="label">ESTIMATED API COST</span><h2 id="estimated-cost-title">What the estimate means</h2></div>
          <p>When the optional status-line bridge is connected, Pomegr displays Claude Code&apos;s client-side <code>cost.total_cost_usd</code> session estimate. Claude Code calculates it using standard API list rates, so it can help compare session consumption but may differ from an actual API bill and does not represent the marginal cost of subscription usage. Pomegr does not reconstruct this value from transcript tokens.</p>
        </section>

        <section id="known-issues" className="aboutNote" aria-labelledby="known-issues-title">
          <div><span className="label">KNOWN ISSUES</span><h2 id="known-issues-title">Known issues</h2></div>
          <ul className="aboutIssueList">
            <li>
              <h3>Codex cache-write usage is not available</h3>
              <p>Subscription-backed Codex session records currently report cache-write token counts as zero, so Pomegr omits the Cache write metric and cache-write classifications for Codex. Cache-read counts remain available. Follow <a href="https://github.com/openai/codex/issues/35300" target="_blank" rel="noreferrer">openai/codex#35300</a> for the upstream limitation.</p>
            </li>
          </ul>
        </section>

        <section id="license" className="aboutNote" aria-labelledby="license-title">
          <div><span className="label">OPEN SOURCE</span><h2 id="license-title">Source and license</h2></div>
          <div className="legalCopy">
            <p>Copyright © 2026 Leandro Carvalho. Pomegr is free software under the GNU Affero General Public License version 3 only and is provided without warranty. The notices below are copies included in this application.</p>
            <nav aria-label="Legal and source documents">
              <a href="/legal/LICENSE.txt">AGPL license</a>
              <a href="/legal/NOTICE.txt">Copyright and warranty notice</a>
              <a href="/legal/SOURCE.txt">Corresponding source</a>
              <a href="/legal/THIRD_PARTY_NOTICES.txt">Third-party notices</a>
              <a href="/legal/TRADEMARKS.txt">Trademark policy</a>
            </nav>
            <p>The <a href="https://github.com/Lecarvalho/pomegr" target="_blank" rel="noreferrer">corresponding source code</a> is also available from the official repository.</p>
          </div>
        </section>
      </article>
    </main>
  );
}

function PrincipleCard({ label, title, detail }: { label: string; title: string; detail: string }) {
  return <div><span className="label">{label}</span><h2>{title}</h2><p>{detail}</p></div>;
}
