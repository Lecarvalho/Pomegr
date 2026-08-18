import type { Metadata } from "next";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { WaitlistStatusLink } from "../components/WaitlistStatusLink";
import styles from "./AboutPage.module.css";

const REPOSITORY = "https://github.com/Lecarvalho/pomegr";

export const metadata: Metadata = {
  title: "About Pomegr",
  description: "How Pomegr observes coding-agent sessions locally, read-only, and without exposing conversations.",
};

export default function AboutPage() {
  return (
    <main className={styles.about}>
      <div className={styles.printMarks} aria-hidden="true"><i /><i /><i /><i /></div>
      <SiteHeader current="about" />

      <article>
        <section className={styles.intro} aria-labelledby="about-title">
          <div className={styles.introCopy}>
            <h1 id="about-title">A quiet view into <em>active work.</em></h1>
            <p>
              Pomegr is a local-first, read-only observer for coding-agent sessions. It turns existing session
              records into a legible view of execution—without turning the conversation itself into a product.
            </p>
          </div>
          <aside className={styles.fieldNote} aria-label="Pomegr boundary">
            <span>Observer’s note</span>
            <strong>Close to the work.<br />Outside its control loop.</strong>
            <p>Pomegr watches. It does not direct.</p>
          </aside>
        </section>

        <section className={styles.boundary} aria-labelledby="boundary-title">
          <div className={styles.boundaryHeading}>
            <h2 id="boundary-title">The boundary is the product.</h2>
            <p>
              The privileged monitor stays on loopback. The dashboard receives only bounded, normalized metadata
              shaped for observation.
            </p>
          </div>

          <ol className={styles.flow} aria-label="Local Pomegr data flow">
            <FlowStep title="Local session records" detail="Provider files already on your device" />
            <FlowStep title="Loopback monitor" detail="Reads and normalizes locally" />
            <FlowStep title="Bounded metadata" detail="Known fields, limited shapes" />
            <FlowStep title="Local dashboard" detail="A read-only operations view" last />
          </ol>
          <div className={styles.exclusion}>
            <strong>Never sent to the browser</strong>
            <p>Raw prompts · responses · commands · credentials · transcripts</p>
          </div>
        </section>

        <section className={styles.ledger} aria-labelledby="ledger-title">
          <div className={styles.ledgerIntro}>
            <h2 id="ledger-title">What the observer stands for.</h2>
            <img
              className={styles.principlesSignal}
              src="/landing/about/observer-principles-signal.webp"
              alt=""
              aria-hidden="true"
            />
          </div>
          <div className={styles.ledgerRows}>
            <Principle
              title="Local-only by default"
              body="Session discovery, transcript parsing, Git inspection, and signal generation stay with the local monitor. The public website is a separate application and contains none of that code."
              annotation="one machine / one boundary"
              imageSrc="/landing/about/phone-observer-sketch.webp"
              imageAlt="A simple ink sketch of a person sitting on the floor and quietly looking at a cellphone."
            />
            <Principle
              title="Read-only in practice"
              body="Pomegr observes existing records and repository state. It does not send commands to agents or write back into their sessions. Any future control action would need an explicit confirmation boundary."
              annotation="observe ≠ operate"
              imageSrc="/landing/about/cat-coffee-sketch.webp"
              imageAlt="A simple ink sketch of a cat holding a small red cup of coffee."
            />
            <Principle
              title="Deterministic signals"
              body="Efficiency signals are reproducible rules tied to concrete events. They are heuristics, not AI judgments, performance grades, or authoritative measurements."
              annotation="show the evidence"
              imageSrc="/landing/about/boy-on-beetle-sketch.webp"
              imageAlt="A playful ink sketch of a boy riding a large friendly red beetle."
            />
            <Principle
              title="Provider-neutral model"
              body="Provider-specific adapters normalize into the same bounded product shapes. Claude Code is the current adapter; the product model is deliberately not named after any provider."
              annotation="adapters may differ / truth may not"
              imageSrc="/landing/about/pomegranate-board-sketch.webp"
              imageAlt="A halved pomegranate resting cut-side up on a walnut cutting board."
            />
          </div>
        </section>

        <section className={styles.openSource} aria-labelledby="source-title">
          <div>
            <h2 id="source-title">Open source is part of the inspection surface.</h2>
            <p>
              The code, metric conventions, privacy boundaries, and notices are public. You can inspect how a
              signal is derived instead of being asked to trust an opaque score.
            </p>
          </div>
          <a href={REPOSITORY} target="_blank" rel="noreferrer">Inspect the source <ArrowIcon /></a>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <div>
            <h2 id="closing-title">Take the observer with you.</h2>
            <p>Join from the landing page with one email. Duplicate signups are kept only once.</p>
          </div>
          <div className={styles.ticket}>
            <div><span>Waitlist</span><code>PMGR / ABOUT</code></div>
            <strong>Your ticket may already be here.</strong>
            <WaitlistStatusLink className={styles.ticketAction} />
            <a className={styles.ticketSecondary} href={REPOSITORY} target="_blank" rel="noreferrer">Use the source now</a>
          </div>
        </section>
      </article>

      <SiteFooter current="about" />
    </main>
  );
}

function FlowStep({ title, detail, last = false }: { title: string; detail: string; last?: boolean }) {
  return (
    <li>
      <span aria-hidden="true"><FlowIcon /></span>
      <div><strong>{title}</strong><small>{detail}</small></div>
      {!last ? <ArrowIcon /> : null}
    </li>
  );
}

function Principle({
  title,
  body,
  annotation,
  imageSrc,
  imageAlt,
}: {
  title: string;
  body: string;
  annotation: string;
  imageSrc: string;
  imageAlt: string;
}) {
  return (
    <article>
      <h3>{title}</h3>
      <p>{body}</p>
      <figure className={styles.principleIllustration}>
        <div className={styles.principleImageCrop}>
          <img src={imageSrc} width="1536" height="1024" loading="lazy" alt={imageAlt} />
        </div>
      </figure>
      <span>{annotation}</span>
    </article>
  );
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
}

function FlowIcon() {
  return <svg viewBox="0 0 28 28" aria-hidden="true"><rect x="4" y="4" width="20" height="20" /><path d="M9 14h10M15 10l4 4-4 4" /></svg>;
}
