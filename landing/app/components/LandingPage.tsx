import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import { WaitlistActions } from "./WaitlistActions";
import styles from "./LandingPage.module.css";

const GITHUB_URL = "https://github.com/Lecarvalho/pomegr";

export function LandingPage() {
  return (
    <main className={styles.landing}>
      <div className={styles.printMarks} aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <SiteHeader current="home" />

      <section className={styles.hero} id="observer" aria-labelledby="hero-title">
        <div className={styles.monitor}>
          <span className={styles.monitorGrit} aria-hidden="true" />
          <div className={styles.monitorTopline}>
            <div>
              <span className={styles.previewLabel}>Illustrative preview</span>
              <span className={styles.liveDot} />
              <code>session-7f3a</code>
              <span className={styles.activeTag}>Active</span>
              <span className={styles.startedMeta}>Started 2h 17m ago</span>
            </div>
            <div className={styles.readOnlyStatus}>
              <span><strong>Read-only observer</strong><small>Pomegr never writes.</small></span>
              <LockIcon />
            </div>
          </div>

          <aside className={styles.sessionRail} aria-label="Illustrative sessions">
            <div className={styles.localNote}>
              <span className={styles.liveDot} />
              <strong>Local first</strong>
              <p>All data stays<br />on this device.</p>
            </div>
            <p className={styles.railLabel}>Sessions</p>
            <div className={`${styles.sessionItem} ${styles.sessionItemActive}`}>
              <strong>session-7f3a</strong>
              <span>2h 17m · Active</span>
            </div>
            <div className={styles.sessionItem}>
              <strong>session-b2c4</strong>
              <span>Yesterday</span>
            </div>
            <div className={styles.sessionItem}>
              <strong>session-9d1e</strong>
              <span>May 6</span>
            </div>
            <div className={styles.sessionItem}>
              <strong>session-3a91</strong>
              <span>May 5</span>
            </div>
            <div className={styles.settingsItem}><SettingsIcon />Settings</div>
          </aside>

          <div className={styles.pitchAssembly}>
            <span className={styles.tape} aria-hidden="true" />
            <div className={styles.pitchCard}>
              <h1 id="hero-title">Visualize what your agents are <em>doing.</em></h1>
              <p>Live execution metadata.<br />Deterministic signals.<br />Visual insights.</p>
              <div className={styles.heroActions}>
                <a className={styles.primaryAction} href="#waitlist">Join the waitlist <ArrowIcon /></a>
                <a className={styles.repoAction} href={GITHUB_URL} target="_blank" rel="noreferrer">View public repo</a>
              </div>
              <p className={styles.platformLine}>
                <span><LaptopIcon />Desktop · planned</span><i>·</i><span><PhoneIcon />iOS · planned</span><i>·</i><span><PhoneIcon />Android · planned</span>
              </p>
              <span className={styles.localStamp}>Local<br />first<br /><small>by design</small></span>
            </div>
          </div>

          <div className={styles.observerCanvas}>
            <p className={`${styles.annotation} ${styles.spawnedNote}`}>spawned<br />by session <NoteArrow /></p>
            <p className={`${styles.annotation} ${styles.observeNote}`}>observe <NoteArrow /></p>

            <article className={styles.sourceCard}>
              <div className={styles.cardHeading}>
                <TerminalIcon />
                <span>Main session</span>
              </div>
              <strong>agent-runtime</strong>
              <span className={styles.processId}>PID 48211</span>
              <dl>
                <div><dt>cwd</dt><dd>~/projects/atlas</dd></div>
                <div><dt>branch</dt><dd>feat/search-refactor</dd></div>
                <div><dt>started</dt><dd>10:14:22 AM</dd></div>
              </dl>
              <span className={styles.runningState}><i />Running</span>
            </article>

            <svg className={styles.connections} viewBox="0 0 250 420" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id="observer-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path className={styles.connectorArrow} d="M0 0 8 4 0 8Z" />
                </marker>
              </defs>
              <path className={styles.connectionPath} d="M4 106 C88 106 100 2 250 2" markerEnd="url(#observer-arrow)" />
              <path className={styles.connectionPath} d="M4 139 C88 139 100 137 250 137" markerEnd="url(#observer-arrow)" />
              <path className={styles.connectionPath} d="M4 171 C88 171 100 283 250 283" markerEnd="url(#observer-arrow)" />
              <path className={styles.connectionPath} d="M4 203 C88 203 100 408 250 408" markerEnd="url(#observer-arrow)" />
              <circle cx="4" cy="106" r="3" />
              <circle cx="4" cy="139" r="3" />
              <circle cx="4" cy="171" r="3" />
              <circle cx="4" cy="203" r="3" />
            </svg>

            <div className={styles.signalStack} id="observer-signals">
              <SignalPanel tone="lavender" icon={<ContextIcon />} title="Agent context" meta="@ 2,843 files · 1.2 GB →">
                <div className={styles.contextBody}>
                  <AreaTrace />
                  <p><span>Most active</span><strong>src/search/index.ts</strong><small>8m ago</small></p>
                </div>
              </SignalPanel>

              <SignalPanel tone="green" icon={<TaskIcon />} title="Tasks" meta="7 tasks · 2 blocked →">
                <ul className={styles.taskList}>
                  <li><i className={styles.working} />Implement fuzzy search <span>1h ago</span></li>
                  <li><i className={styles.done} />Refactor results ranking <span>24m ago</span></li>
                  <li><i className={styles.working} />Add keyboard navigation <b>Blocked</b><span>12m ago</span></li>
                  <li><i />Write tests <span>—</span></li>
                </ul>
              </SignalPanel>

              <SignalPanel tone="amber" icon={<GitIcon />} title="Git activity" meta="feat/search-refactor →">
                <div className={styles.gitActivity}>
                  <GitGraph />
                  <ul className={styles.commitList}>
                    <li><code>a1b2c3d</code><span>Refactor search index</span><small>18m ago</small></li>
                    <li><code>d4e5f6a</code><span>Add trigram matcher</span><small>42m ago</small></li>
                    <li><code>e7f8a9b</code><span>WIP</span><small>1h ago</small></li>
                  </ul>
                </div>
              </SignalPanel>

              <SignalPanel tone="plain" icon={<PulseIcon />} title="Usage" meta="Window 2h →">
                <div className={styles.usageGrid}>
                  <UsageMetric label="CPU" value="14%" path="M0 21 L8 20 12 7 17 24 24 17 31 20 37 9 43 23 51 18 58 22 66 12 73 21" />
                  <UsageMetric label="MEM" value="2.1 GB" path="M0 22 L7 17 13 20 19 11 25 21 32 8 38 17 45 13 51 23 57 14 64 18 72 9" />
                  <UsageMetric label="NET" value="↓ 240 KB/s" path="M0 21 L9 19 14 23 20 13 27 20 34 16 40 21 48 10 56 17 62 12 70 20 76 9" />
                  <UsageMetric label="TOKENS" value="128.4K" path="M0 23 L7 21 13 10 18 19 26 12 33 21 40 9 46 16 53 13 59 20 66 8 75 15" />
                </div>
              </SignalPanel>
            </div>

            <aside className={styles.legend} aria-label="Observer legend">
              <span className={styles.legendTape}>Legend</span>
              <LegendItem icon={<TerminalIcon />} title="Main session">Root agent process.</LegendItem>
              <LegendItem icon={<ContextIcon />} title="Context">Files, size, and activity the agent can see.</LegendItem>
              <LegendItem icon={<TaskIcon />} title="Tasks">Planned / running / blocked work.</LegendItem>
              <LegendItem icon={<GitIcon />} title="Git">Branches, commits, and diffs.</LegendItem>
              <LegendItem icon={<PulseIcon />} title="Usage">System + token consumption.</LegendItem>
              <LegendItem icon={<LockIcon />} title="Read-only">Pomegr observes.<br />It never writes.</LegendItem>
              <LegendItem icon={<span className={styles.legendDot} />} title="Local-first">Everything stays on this device.</LegendItem>
            </aside>
          </div>

        </div>
      </section>

      <section className={styles.principles} aria-labelledby="principles-title">
        <h2 id="principles-title" className={styles.visuallyHidden}>Why Pomegr</h2>
        <p className={styles.marginNote}>No prompts.<br />No messages.<br />Just signals.</p>
        <article>
          <span>Observe</span>
          <h3>Pomegr watches, so <u>you</u> stay in control.</h3>
          <p>Read-only by design. Pomegr never sends commands to your agents or stores their conversations.</p>
        </article>
        <article className={styles.principleDiagram}>
          <div className={styles.diagramSticker}>
            <span className={styles.diagramTape} aria-hidden="true" />
            <ObserverDiagram />
          </div>
          <div className={styles.principleCopy}>
            <span>Understand</span>
            <h3>See <u>execution</u>, not interpretation.</h3>
            <p>Session state, context snapshots, tasks, Git changes, usage limits, and traceable signals.</p>
          </div>
        </article>
        <article>
          <span>Keep private</span>
          <h3>Everything stays on your machine.</h3>
          <p>Local-first storage.<br />No accounts, no cloud,<br />no surprises.</p>
        </article>
        <aside className={styles.trustNote} aria-label="Built for focus and trust">
          <strong>Built for<br />focus<br />&amp; trust</strong>
          <p><NoteArrow />Works offline.<br />Sync is your<br />choice.</p>
        </aside>
      </section>

      <section className={styles.statement}>
        <div>
          <EyeIcon />
          <h2>Observe everything.<br />Change nothing.</h2>
        </div>
        <p>
          Pomegr turns existing session records into a live, explainable view. It does not expose raw prompts,
          responses, commands, or credentials.
        </p>
      </section>

      <section className={styles.waitlist} id="waitlist" aria-labelledby="waitlist-title">
        <div className={styles.waitlistIntro}>
          <p className={styles.annotation}>Planned platforms · desktop, iOS, Android</p>
          <h2 id="waitlist-title">Take the observer with you.</h2>
          <p>Tell us where you want Pomegr next. The current source is public and free to use now.</p>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">Explore the public repository <ArrowIcon /></a>
        </div>
        <div className={styles.waitlistTicket}>
          <div className={styles.ticketTopline}><span>Waitlist</span><code>PMGR / 001</code></div>
          <h3>Get the app when it lands.</h3>
          <WaitlistActions />
        </div>
      </section>

      <SiteFooter current="home" />
    </main>
  );
}

function SignalPanel({
  tone,
  icon,
  title,
  meta,
  children,
}: {
  tone: "lavender" | "green" | "amber" | "plain";
  icon: React.ReactNode;
  title: string;
  meta: string;
  children: React.ReactNode;
}) {
  return (
    <article className={`${styles.signalPanel} ${styles[`signalPanel_${tone}`]}`}>
      <div className={styles.signalHeading}>
        <span>{icon}<strong>{title}</strong></span>
        <small>{meta}</small>
      </div>
      {children}
    </article>
  );
}

function LegendItem({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className={styles.legendItem}>
      <span>{icon}</span>
      <p><strong>{title}</strong>{children}</p>
    </div>
  );
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
}

function TerminalIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
}

function ContextIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM8 9h8M8 12h8M8 15h5" /></svg>;
}

function TaskIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM8 12l2 2 5-6" /></svg>;
}

function GitIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="5" r="2" /><circle cx="7" cy="19" r="2" /><circle cx="17" cy="9" r="2" /><path d="M7 7v10M9 17c5 0 8-2 8-6" /></svg>;
}

function PulseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="1" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>;
}

function LaptopIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="11" /><path d="M3 18h18l-1 2H4Z" /></svg>;
}

function PhoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="1" /><path d="M10 5h4M11 19h2" /></svg>;
}

function NoteArrow() {
  return <svg className={styles.noteArrow} viewBox="0 0 72 34" aria-hidden="true"><path d="M2 9c20-4 39 0 60 12M52 13l10 8-12 4" /></svg>;
}

function AreaTrace() {
  return (
    <svg className={styles.areaTrace} viewBox="0 0 230 58" role="img" aria-label="Illustrative recent context activity">
      <defs>
        <linearGradient id="context-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#aaa0ca" stopOpacity=".68" />
          <stop offset="1" stopColor="#aaa0ca" stopOpacity=".08" />
        </linearGradient>
      </defs>
      <path className={styles.areaFill} d="M0 51 C8 48 10 27 18 25 S29 38 37 37 49 45 58 44 70 51 80 47 91 33 102 38 115 31 126 43 138 32 148 24 158 34 170 44 181 39 194 42 205 31 216 34 224 18 230 10 L230 58 0 58Z" />
      <path className={styles.areaLine} d="M0 51 C8 48 10 27 18 25 S29 38 37 37 49 45 58 44 70 51 80 47 91 33 102 38 115 31 126 43 138 32 148 24 158 34 170 44 181 39 194 42 205 31 216 34 224 18 230 10" />
    </svg>
  );
}

function GitGraph() {
  return (
    <svg className={styles.gitGraph} viewBox="0 0 46 70" aria-hidden="true">
      <path d="M10 4v18c0 13 24 9 24 23v21M10 22c0 12 24 9 24 23" />
      <circle cx="10" cy="4" r="3" /><circle cx="10" cy="22" r="3" /><circle cx="34" cy="45" r="3" /><circle cx="34" cy="66" r="3" />
    </svg>
  );
}

function UsageMetric({ label, value, path }: { label: string; value: string; path: string }) {
  return (
    <div className={styles.usageMetric}>
      <p><strong>{label}</strong><span>{value}</span></p>
      <svg viewBox="0 0 76 28" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
    </div>
  );
}

function EyeIcon() {
  return <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M5 32s10-16 27-16 27 16 27 16-10 16-27 16S5 32 5 32Z" /><circle cx="32" cy="32" r="7" /><path d="M32 3v8M32 53v8M3 32h8M53 32h8" /></svg>;
}

function ObserverDiagram() {
  return (
    <svg className={styles.observerDiagram} viewBox="0 0 250 150" aria-label="One session branching into observed metadata">
      <rect x="95" y="8" width="60" height="38" />
      <path d="m112 20 8 7-8 7M126 34h12" />
      <path d="M125 46v28M125 74H35v25M125 74H95v25M125 74h30v25M125 74h90v25" />
      <rect x="15" y="99" width="40" height="38" />
      <rect x="75" y="99" width="40" height="38" />
      <rect x="135" y="99" width="40" height="38" />
      <rect x="195" y="99" width="40" height="38" />
      <path d="M25 118h20M85 118h20M145 112h20M145 122h14M205 121l6-8 5 11 8-15" />
    </svg>
  );
}
