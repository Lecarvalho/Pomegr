import type { Metadata } from "next";
import Link from "next/link";
import { ThreadlightBrand } from "../components/ThreadlightBrand";

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
        <Link className="ghostButton aboutBack" href="/">Back to dashboard</Link>
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
      </article>
    </main>
  );
}

function PrincipleCard({ label, title, detail }: { label: string; title: string; detail: string }) {
  return <div><span className="label">{label}</span><h2>{title}</h2><p>{detail}</p></div>;
}
