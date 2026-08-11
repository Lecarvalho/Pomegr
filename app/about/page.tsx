import type { Metadata } from "next";
import Link from "next/link";
import { ThreadlightBrand } from "../components/ThreadlightBrand";
import { ThemeToggle } from "../components/ThemeToggle";

export const metadata: Metadata = {
  title: "About · Threadlight",
  description: "How Threadlight observes coding-agent sessions while keeping raw conversation content private.",
};

export default function About() {
  const principles = [
    { label: "LOCAL-FIRST", title: "Your session stays local", detail: "Threadlight reads local session records and presents a normalized, read-only view." },
    { label: "CLEAR PROVENANCE", title: "Summaries stay attributed", detail: "When a provider records a session summary, Threadlight displays bounded plain text and labels where it came from." },
    { label: "DETERMINISTIC", title: "Signals are explainable", detail: "Efficiency signals come from concrete execution events and documented rules, not hidden AI judgment." },
  ];
  return (
    <main className="aboutShell">
      <header className="topbar">
        <ThreadlightBrand label="Threadlight dashboard" />
        <div className="topActions">
          <ThemeToggle />
          <Link className="ghostButton aboutBack" href="/">Back to dashboard</Link>
        </div>
      </header>

      <article className="aboutPage">
        <div className="eyebrow"><span /> ABOUT THREADLIGHT</div>
        <h1>A quiet view into active work.</h1>
        <p className="aboutLead">Observe coding-agent sessions without exposing prompts or responses. Threadlight analyzes execution metadata only.</p>

        <section className="aboutGrid" aria-label="Threadlight principles">
          {principles.map((principle) => <PrincipleCard key={principle.label} {...principle} />)}
        </section>

        <section className="aboutNote" aria-labelledby="estimated-cost-title">
          <div><span className="label">ESTIMATED API COST</span><h2 id="estimated-cost-title">What the estimate means</h2></div>
          <p>When the optional status-line bridge is connected, Threadlight displays Claude Code&apos;s client-side <code>cost.total_cost_usd</code> session estimate. Claude Code calculates it using standard API list rates, so it can help compare session consumption but may differ from an actual API bill and does not represent the marginal cost of subscription usage. Threadlight does not reconstruct this value from transcript tokens.</p>
        </section>

        <section id="license" className="aboutNote" aria-labelledby="license-title">
          <div><span className="label">OPEN SOURCE</span><h2 id="license-title">Source and license</h2></div>
          <div className="legalCopy">
            <p>Copyright © 2026 Leandro Carvalho. Threadlight is free software under the GNU Affero General Public License version 3 only and is provided without warranty. The notices below are copies included in this application.</p>
            <nav aria-label="Legal and source documents">
              <a href="/legal/LICENSE.txt">AGPL license</a>
              <a href="/legal/NOTICE.txt">Copyright and warranty notice</a>
              <a href="/legal/SOURCE.txt">Corresponding source</a>
              <a href="/legal/THIRD_PARTY_NOTICES.txt">Third-party notices</a>
              <a href="/legal/TRADEMARKS.txt">Trademark policy</a>
            </nav>
            <p>The <a href="https://github.com/Lecarvalho/threadlight" target="_blank" rel="noreferrer">corresponding source code</a> is also available from the official repository.</p>
          </div>
        </section>
      </article>
    </main>
  );
}

function PrincipleCard({ label, title, detail }: { label: string; title: string; detail: string }) {
  return <div><span className="label">{label}</span><h2>{title}</h2><p>{detail}</p></div>;
}
