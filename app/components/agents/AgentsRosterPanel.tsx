"use client";

import { useMemo, useState } from "react";
import type { AgentsAnalyticsSnapshot, AgentsRun } from "../../../shared/agents-contract";
import { relativeTime, sessionListTime } from "../../dashboard-utils";
import { CommandTable, type CommandTableColumn } from "../command-center/CommandTable";
import { CommandEmpty, CommandSelect } from "../command-center/CommandPage";
import { ROLE_LABELS, contextLabel, statusLabel } from "./agent-presentation";
import styles from "./AgentsView.module.css";

type RosterFilter = "all" | AgentsRun["status"];

export function AgentsRosterPanel({ snapshot, onInspect }: { snapshot: AgentsAnalyticsSnapshot; onInspect: (title: string, runs: AgentsRun[], trigger: HTMLElement) => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<RosterFilter>("all");
  const visible = useMemo(() => snapshot.roster.filter((run) => {
    if (status !== "all" && run.status !== status) return false;
    const haystack = [run.assignment, run.label, run.model, run.project, run.sessionTitle, run.role].filter(Boolean).join(" ").toLowerCase();
    return !query.trim() || haystack.includes(query.trim().toLowerCase());
  }), [query, snapshot.roster, status]);
  const stateClass = (value: AgentsRun["status"]) => value === "active" ? styles.stateActive : value === "needs_input" ? styles.stateNeedsInput : "";
  const columns: CommandTableColumn<AgentsRun>[] = [
    { id: "assignment", label: "Agent / assignment", colClassName: styles.colAssignment, renderCell: (run) => <div className={run.depth > 0 ? styles.child : undefined} style={run.depth > 0 ? { paddingLeft: `${Math.min(run.depth, 5) * 16}px` } : undefined}>{run.depth > 0 && <span className={styles.branch} aria-hidden="true" />}<button type="button" className={styles.assignment} onClick={(event) => onInspect(run.assignment || run.label, [run], event.currentTarget)}><strong>{run.assignment || run.label}</strong><small>{run.project} / {run.sessionTitle} · {run.scope === "main" ? "Main" : "Delegated"}</small></button></div> },
    { id: "model", label: "Model", colClassName: styles.colModel, renderCell: (run) => run.model || "—" },
    { id: "role", label: "Role", colClassName: styles.colRole, renderCell: (run) => ROLE_LABELS[run.role] },
    { id: "state", label: "State", colClassName: styles.colState, renderCell: (run) => <span className={`${styles.state} ${stateClass(run.status)}`}>{statusLabel(run.status)}</span> },
    { id: "context", label: "Latest context", colClassName: styles.colContext, renderCell: (run) => <span className={styles.context}>{contextLabel(run.latestContextTotal)}</span> },
    { id: "activity", label: "Last activity", colClassName: styles.colActivity, renderCell: (run) => run.lastSeen ? <time dateTime={run.lastSeen} title={sessionListTime(run.lastSeen)}>{relativeTime(run.lastSeen)}</time> : "—" },
  ];
  return <section className={`${styles.panel} ${styles.rosterPanel}`} aria-label="Live agents"><div className={styles.rosterToolbar}><label className="commandVisuallyHidden" htmlFor="agent-roster-search">Find an agent or assignment</label><input id="agent-roster-search" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Find an agent or assignment…" aria-label="Find an agent or assignment" /><label className="commandVisuallyHidden" htmlFor="agent-roster-status">Agent state</label><CommandSelect id="agent-roster-status" value={status} onChange={(event) => setStatus(event.currentTarget.value as RosterFilter)} aria-label="Agent state"><option value="all">All states</option><option value="active">Active</option><option value="needs_input">Needs input</option><option value="waiting">Waiting</option><option value="warm">Warm</option><option value="finished">Finished</option><option value="stopped">Stopped</option><option value="idle">Idle</option><option value="unknown">Unknown</option></CommandSelect><span className={styles.rosterCount}>{visible.length} of {snapshot.roster.length} agents</span></div><CommandTable caption="Observed live agents" rows={visible} columns={columns} getRowKey={(run) => run.id} className={styles.rosterTable} emptyState={<CommandEmpty title="No agents match these filters" detail="Try another state or search term." icon="agents" />} /><p className={styles.panelNote}>Agents in live sessions · latest observed state. Context is each agent’s latest non-zero snapshot.</p></section>;
}
