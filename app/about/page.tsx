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
        <p className="aboutLead">Watching Claude Code quietly. Prompt and response text stay out of the dashboard; only execution metadata is analyzed.</p>

        <section className="aboutGrid" aria-label="Threadlight principles">
          {principles.map((principle) => <PrincipleCard key={principle.label} {...principle} />)}
        </section>
      </article>
    </main>
  );
}

function PrincipleCard({ label, title, detail }: { label: string; title: string; detail: string }) {
  return <div><span className="label">{label}</span><h2>{title}</h2><p>{detail}</p></div>;
}
