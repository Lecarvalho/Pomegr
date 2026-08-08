import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About · Threadlight",
  description: "How Threadlight observes coding-agent sessions while keeping raw conversation content private.",
};

export default function About() {
  return (
    <main className="aboutShell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Threadlight dashboard">
          <span className="brandMark"><i /><i /><i /></span>
          <span>Threadlight</span>
        </Link>
        <Link className="ghostButton aboutBack" href="/">Back to dashboard</Link>
      </header>

      <article className="aboutPage">
        <div className="eyebrow"><span /> ABOUT THREADLIGHT</div>
        <h1>A quiet view into active work.</h1>
        <p className="aboutLead">Watching Claude Code quietly. Prompt and response text stay out of the dashboard; only execution metadata is analyzed.</p>

        <section className="aboutGrid" aria-label="Threadlight principles">
          <div>
            <span className="label">LOCAL-FIRST</span>
            <h2>Your session stays local</h2>
            <p>Threadlight reads local session records and presents a normalized, read-only view.</p>
          </div>
          <div>
            <span className="label">CLEAR PROVENANCE</span>
            <h2>Summaries stay attributed</h2>
            <p>When a provider records a session summary, Threadlight displays bounded plain text and labels where it came from.</p>
          </div>
          <div>
            <span className="label">DETERMINISTIC</span>
            <h2>Signals are explainable</h2>
            <p>Efficiency signals come from concrete execution events and documented rules, not hidden AI judgment.</p>
          </div>
        </section>
      </article>
    </main>
  );
}
