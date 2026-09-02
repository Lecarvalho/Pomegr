"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AgentsRun } from "../../../shared/agents-contract";
import { relativeTime, sessionListTime } from "../../dashboard-utils";
import { useAgents } from "../../agents-client";
import { CommandEmpty, CommandSelect } from "../command-center/CommandPage";
import { AgentEvidencePanel } from "./AgentEvidencePanel";
import { ModelRanking, PatternsPanel, RoleMatrix, WorkPanel } from "./AgentsModelPanels";
import { AgentsRosterPanel } from "./AgentsRosterPanel";
import styles from "./AgentsView.module.css";

type Scope = "all" | "main" | "delegated";
type Tab = "models" | "live";

function SelectionNotice({ project, days, scope, connected }: { project: string; days: number; scope: Scope; connected: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  if (!visible && connected) return null;
  const requested = `${scope === "all" ? "All agents" : scope === "main" ? "Main agents" : "Delegated agents"} · ${project === "all" ? "All projects" : project} · Last ${days} days`;
  return <p className={`${styles.notice}${connected ? "" : ` ${styles.noticeWarning}`}`} role="status">
    {connected ? `Loading ${requested}. Your current selection stays visible.` : `Could not load ${requested}. Your current selection stays visible. Pomegr will retry automatically.`}
  </p>;
}

export function AgentsView() {
  const [project, setProject] = useState<string | "all">("all");
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [scope, setScope] = useState<Scope>("all");
  const [tab, setTab] = useState<Tab>("models");
  const [selection, setSelection] = useState<{ title: string; runs: AgentsRun[] } | null>(null);
  const evidenceTrigger = useRef<HTMLElement | null>(null);
  const result = useAgents({ project, days, scope });
  // Retain only the displayed response, never a cache of filter variants. Apply the
  // controls and their matching evidence together once the next response is ready.
  const [retained, setRetained] = useState(result);
  if (result.data && result !== retained) {
    setRetained(result);
    if (retained.data && (result.data.filters.project !== retained.data.filters.project || result.data.filters.days !== retained.data.filters.days || result.data.filters.scope !== retained.data.filters.scope)) setSelection(null);
  }
  const { data, checkedAt } = result.data ? result : retained;
  const applied = data?.filters || { project, days, scope };
  const switching = applied.project !== project || applied.days !== days || applied.scope !== scope;
  const loading = result.loading;
  const connected = switching ? retained.connected : result.connected;

  // A selected project remains a valid option while its independent cache is loading.
  const projects = useMemo(() => Array.from(new Set([...(data?.filters.projects || []), ...(project === "all" ? [] : [project])])).sort((left, right) => left.localeCompare(right)), [data?.filters.projects, project]);
  const openEvidence = useCallback((title: string, runs: AgentsRun[], trigger: HTMLElement) => { evidenceTrigger.current = trigger; setSelection({ title, runs }); }, []);
  const closeEvidence = useCallback(() => { setSelection(null); window.requestAnimationFrame(() => evidenceTrigger.current?.focus()); }, []);
  const setActiveTab = (next: Tab) => { setTab(next); setSelection(null); };
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: Tab) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "models" : event.key === "End" ? "live" : current === "models" ? "live" : "models";
    setActiveTab(next); window.requestAnimationFrame(() => document.getElementById(`agents-tab-${next}`)?.focus());
  };
  const snapshotTime = data?.generatedAt || checkedAt;
  const partial = data && (data.coverage.missingSessions > 0 || data.coverage.truncated);
  const missingAgentEvidence = data && data.summary.runCount === 0 && data.coverage.missingSessions > 0;

  return <section className={styles.agentsView} aria-busy={loading && !data || undefined}>
    <header className={styles.pageHead}><div><h1>Agents</h1><p>See which models you use, the roles they take, and how you delegate.</p></div>{snapshotTime && <div className={styles.snapshot}><strong>Summary observed</strong><time dateTime={snapshotTime} title={sessionListTime(snapshotTime)}>{relativeTime(snapshotTime)}</time></div>}</header>
    <div className={styles.tabs} role="tablist" aria-label="Agent views"><button className={styles.tab} role="tab" id="agents-tab-models" aria-selected={tab === "models"} aria-controls="agents-models-panel" tabIndex={tab === "models" ? 0 : -1} type="button" onClick={() => setActiveTab("models")} onKeyDown={(event) => tabKeyDown(event, "models")}>Models &amp; work</button><button className={styles.tab} role="tab" id="agents-tab-live" aria-selected={tab === "live"} aria-controls="agents-live-panel" tabIndex={tab === "live" ? 0 : -1} type="button" onClick={() => setActiveTab("live")} onKeyDown={(event) => tabKeyDown(event, "live")}>Live agents {data && <span className={styles.tabCount}>{data.roster.length}</span>}</button></div>
    <div className={styles.filters} aria-label="Agent filters"><label className={styles.filter}><span className={styles.filterLabel}>Project</span><CommandSelect aria-label="Project" value={applied.project} onChange={(event) => { setProject(event.currentTarget.value); setSelection(null); }}><option value="all">All projects</option>{projects.map((value) => <option value={value} key={value}>{value}</option>)}</CommandSelect></label>{tab === "models" && <label className={styles.filter}><span className={styles.filterLabel}>Period</span><CommandSelect aria-label="Period" value={applied.days} onChange={(event) => { setDays(Number(event.currentTarget.value) as 7 | 30 | 90); setSelection(null); }}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></CommandSelect></label>}<div className={styles.segmented} role="group" aria-label="Agent scope"><button type="button" aria-pressed={applied.scope === "all"} onClick={() => { setScope("all"); setSelection(null); }}>All agents</button><button type="button" aria-pressed={applied.scope === "main"} onClick={() => { setScope("main"); setSelection(null); }}>Main</button><button type="button" aria-pressed={applied.scope === "delegated"} onClick={() => { setScope("delegated"); setSelection(null); }}>Delegated</button></div>{data && <details className={styles.coverage}><summary>About this data</summary><div className={styles.coverageBox}><strong>{data.coverage.retainedSessions} retained sessions contribute {data.coverage.retainedRuns} agent runs.</strong><br />{data.coverage.missingSessions ? `${data.coverage.missingSessions} eligible session${data.coverage.missingSessions === 1 ? " has" : "s have"} no retained agent evidence.` : "All eligible retained sessions contributed agent evidence."}{data.coverage.missingSessions > 0 && <p>Some past sessions may remain unavailable.</p>}{data.coverage.truncated ? " Retention is bounded; this selection may be incomplete." : ""}</div></details>}</div>
    {loading && !data && <p className={styles.notice} role="status">Loading agent information. You can leave this page and check back later; it refreshes automatically when you return.</p>}
    {switching && <SelectionNotice key={JSON.stringify([project, days, scope])} project={project} days={days} scope={scope} connected={result.connected} />}
    {partial && <p className={`${styles.notice} ${styles.noticeWarning}`} role="status">Partial coverage · {data.coverage.retainedSessions} retained sessions are included.{data.coverage.missingSessions ? ` ${data.coverage.missingSessions} eligible session${data.coverage.missingSessions === 1 ? " has" : "s have"} no retained agent evidence.` : " Retention is bounded for this selection."}</p>}
    {data && !connected && <p className={`${styles.notice} ${styles.noticeWarning}`} role="status">Summary update delayed · Showing the last available values. Pomegr will retry automatically.</p>}
    {loading && !data ? <div className={styles.skeleton} aria-label="Loading agent summary"><div><i /><i /><i /><i /></div><div><i /><i /><i /><i /></div></div> : !data ? <CommandEmpty title="Agent summary unavailable" detail="The local monitor has not provided a summary yet. Pomegr will retry automatically." icon="agents" /> : tab === "models" ? <div id="agents-models-panel" role="tabpanel" aria-labelledby="agents-tab-models" aria-busy={switching || undefined}>
      <div className={styles.summary}>{!missingAgentEvidence && <><span><strong>{data.summary.runCount}</strong> agent runs</span><span><strong>{data.summary.sessionCount}</strong> sessions</span><span><strong>{data.summary.modelCount}</strong> reported models</span></>}</div>
      {data.summary.runCount ? <><div className={styles.primaryGrid}><ModelRanking snapshot={data} onInspect={openEvidence} /><RoleMatrix snapshot={data} onInspect={openEvidence} /></div><div className={styles.secondaryGrid}><WorkPanel snapshot={data} /><PatternsPanel snapshot={data} onInspect={openEvidence} /></div><details className={styles.method}><summary>How are these numbers counted?</summary><p>One agent run is one observed agent within a retained parent session, counted once in the selected scope. The period uses the run’s start date. Main and delegated agents remain separate, and missing model or role evidence stays unreported. These statistics describe retained evidence, not model performance, time worked, or spending.</p></details></> : missingAgentEvidence ? <section className="commandEmpty" aria-live="polite"><span className={styles.waitLoader} aria-hidden="true" data-paused={!connected || undefined} /><h2>Waiting for agent information</h2><p>Check back later. This page updates automatically.</p></section> : <CommandEmpty title="No agents in this selection" detail="Try another project, time range, or agent scope." icon="agents" />}
    </div> : <div id="agents-live-panel" role="tabpanel" aria-labelledby="agents-tab-live" aria-busy={switching || undefined}><div className={styles.summary}><span><strong>{data.roster.length}</strong> live agents</span><span>Latest observed agent state</span></div><AgentsRosterPanel snapshot={data} onInspect={openEvidence} /></div>}
    <AgentEvidencePanel selection={selection} onClose={closeEvidence} />
  </section>;
}
