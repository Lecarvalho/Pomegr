"use client";

import type { CSSProperties } from "react";
import type { AgentsAnalyticsSnapshot, AgentsModelAggregate, AgentsRun } from "../../../shared/agents-contract";
import type { AgentRole } from "../../../shared/monitor-contract";
import { ROLE_LABELS, WORK_LABELS, modelLabel } from "./agent-presentation";
import styles from "./AgentsView.module.css";

type Inspect = (title: string, runs: AgentsRun[], trigger: HTMLElement) => void;
const roleOrder: AgentRole[] = ["explore", "plan", "builder", "reviewer", "tester", "orchestrator", "researcher", "general-purpose", "workflow-worker", "fork", "compaction", "unknown"];
function matchingRuns(snapshot: AgentsAnalyticsSnapshot, model: AgentsModelAggregate["model"], role?: AgentRole) { return snapshot.runs.filter((run) => run.model === model && (!role || run.role === role)); }

export function ModelRanking({ snapshot, onInspect }: { snapshot: AgentsAnalyticsSnapshot; onInspect: Inspect }) {
  const maximum = Math.max(1, ...snapshot.models.map((model) => model.runCount));
  const reportable = snapshot.models.filter((model) => model.model !== null);
  const unreported = snapshot.models.filter((model) => model.model === null);
  return <section className={`${styles.panel} ${styles.ranking}`} aria-labelledby="agents-models-heading"><header className={styles.panelHead}><div><h2 id="agents-models-heading">Models used</h2><p>Latest reported model per agent run</p></div><span className={styles.subtleLabel}>Runs</span></header>
    <div className={styles.rankList}>{reportable.map((model) => <ModelRow key={model.model} model={model} maximum={maximum} total={snapshot.summary.runCount} onInspect={onInspect} snapshot={snapshot} />)}</div>
    <div className={styles.legend}><span><i className={`${styles.swatch} ${styles.mainFill}`} />Main agents</span><span><i className={`${styles.swatch} ${styles.delegatedFill}`} />Delegated agents</span></div>
    {unreported.map((model) => <div className={styles.unreported} key="unreported"><button type="button" className={styles.inlineButton} onClick={(event) => onInspect("Unreported model", matchingRuns(snapshot, model.model), event.currentTarget)}>Unreported model</button><span className={styles.dataValue}>{model.runCount} · {snapshot.summary.runCount ? Math.round(model.runCount / snapshot.summary.runCount * 100) : 0}%</span></div>)}
    <p className={styles.panelNote}>Each run counts once. A model is its latest reported model, not a whole-run model history.</p>
  </section>;
}

function ModelRow({ model, maximum, total, snapshot, onInspect }: { model: AgentsModelAggregate; maximum: number; total: number; snapshot: AgentsAnalyticsSnapshot; onInspect: Inspect }) {
  return <button type="button" className={styles.modelRow} onClick={(event) => onInspect(modelLabel(model.model), matchingRuns(snapshot, model.model), event.currentTarget)} aria-label={`Inspect ${modelLabel(model.model)} agent runs`}><span className={styles.modelLine}><span className={styles.modelName}>{modelLabel(model.model)}</span><span className={styles.modelCount}><strong>{model.runCount}</strong>{total ? `${Math.round(model.runCount / total * 100)}%` : "—"}</span></span><span className={styles.track} aria-hidden="true"><i className={styles.mainFill} style={{ width: `${model.mainRunCount / maximum * 100}%` }} /><i className={styles.delegatedFill} style={{ width: `${model.delegatedRunCount / maximum * 100}%` }} /></span></button>;
}

export function RoleMatrix({ snapshot, onInspect }: { snapshot: AgentsAnalyticsSnapshot; onInspect: Inspect }) {
  const present = new Set(snapshot.models.flatMap((model) => model.roles.map(({ role }) => role)));
  const roles = roleOrder.filter((role) => present.has(role));
  const maximum = Math.max(1, ...snapshot.models.flatMap((model) => roles.map((role) => model.roles.find((entry) => entry.role === role)?.runCount || 0)));
  return <section className={styles.panel} aria-labelledby="agents-role-heading"><header className={styles.panelHead}><div><h2 id="agents-role-heading">Models by role</h2><p>Explore how you assign work across your models.</p></div></header><div className={styles.tableScroll} tabIndex={0} aria-label="Models by role table; scroll horizontally on small screens"><table className={styles.matrix}><caption>Observed agent runs by latest reported model and normalized role</caption><thead><tr><th scope="col">Model</th>{roles.map((role) => <th scope="col" key={role}>{ROLE_LABELS[role]}</th>)}</tr></thead><tbody>{snapshot.models.map((model) => <tr key={model.model || "unreported"}><th scope="row">{modelLabel(model.model)}</th>{roles.map((role) => { const count = model.roles.find((entry) => entry.role === role)?.runCount || 0; return <td key={role}>{count ? <button className={styles.matrixCell} type="button" style={{ "--intensity": count / maximum } as CSSProperties} onClick={(event) => onInspect(`${modelLabel(model.model)} · ${ROLE_LABELS[role]}`, matchingRuns(snapshot, model.model, role), event.currentTarget)} aria-label={`${modelLabel(model.model)}, ${ROLE_LABELS[role]}, ${count} runs`}>{count}</button> : <span className={styles.matrixZero} aria-label="No observed runs">—</span>}</td>; })}</tr>)}</tbody></table></div><div className={styles.matrixInstruction}><span>Choose a count to inspect its agent runs.</span><span className={styles.heatLegend}>Fewer <i style={{ "--intensity": .25 } as CSSProperties} /><i style={{ "--intensity": .55 } as CSSProperties} /><i style={{ "--intensity": 1 } as CSSProperties} /> More</span></div><p className={styles.panelNote}>Roles describe an agent’s assigned category. Actual work can span several kinds of activity.</p></section>;
}

export function WorkPanel({ snapshot }: { snapshot: AgentsAnalyticsSnapshot }) {
  const maximum = Math.max(1, ...snapshot.work.map((entry) => entry.count));
  const missingTaskEvidence = snapshot.runs.some((run) => run.executionTaskCount === null);
  const allKnownZero = snapshot.runs.length > 0 && snapshot.runs.every((run) => run.executionTaskCount === 0);
  const emptyMessage = allKnownZero ? "No recorded execution tasks in this selection." : "Recorded execution-task counts are unavailable for this selection.";
  return <section className={styles.panel} aria-labelledby="agents-work-heading"><header className={styles.panelHead}><div><h2 id="agents-work-heading">Observed work</h2><p>Recorded execution tasks across the selected agent runs</p></div><span className={styles.subtleLabel}>Tasks</span></header>{snapshot.work.length ? <div className={styles.workList}>{snapshot.work.map(({ workKind, count }) => <div className={styles.workRow} key={workKind}><span>{WORK_LABELS[workKind]}</span><span className={styles.workBar} aria-hidden="true"><i style={{ width: `${count / maximum * 100}%` }} /></span><span className={styles.workCount}>{count.toLocaleString()}</span></div>)}</div> : <p className={styles.workUnavailable}>{emptyMessage}</p>}{missingTaskEvidence && <p className={styles.workEvidenceNote}>Some selected runs have no recorded execution-task data; displayed counts include available evidence only.</p>}<p className={styles.panelNote}>Activity counts describe recorded actions, not effort or work quality.</p></section>;
}

export function PatternsPanel({ snapshot, onInspect }: { snapshot: AgentsAnalyticsSnapshot; onInspect: Inspect }) {
  const rolePriority: AgentRole[] = ["reviewer", "explore", "builder", "tester", "orchestrator", "plan", "researcher", "general-purpose", "workflow-worker", "fork", "compaction", "unknown"];
  const observations = rolePriority.flatMap((role) => {
    const entries = snapshot.models.map((model) => ({ model, count: model.roles.find((entry) => entry.role === role)?.runCount || 0 })).filter((entry) => entry.count > 0);
    if (!entries.length) return [];
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    const leading = entries.reduce((best, entry) => entry.count > best.count ? entry : best);
    return [{ role, total, model: leading.model, count: leading.count }];
  }).slice(0, 2);
  return <section className={styles.panel} aria-labelledby="agents-patterns-heading"><header className={styles.panelHead}><div><h2 id="agents-patterns-heading">Patterns in this selection</h2><p>Observations you can trace back to agent runs</p></div></header><div className={styles.observations}>{observations.map(({ role, total, model, count }) => <article className={styles.observation} key={`${model.model}-${role}`}><p>{modelLabel(model.model)} appears in {count} of {total} {ROLE_LABELS[role]} {total === 1 ? "run" : "runs"}.</p><button className={styles.inlineButton} type="button" onClick={(event) => onInspect(`${modelLabel(model.model)} · ${ROLE_LABELS[role]}`, matchingRuns(snapshot, model.model, role), event.currentTarget)}>Inspect {ROLE_LABELS[role].toLowerCase()} runs <span aria-hidden="true">→</span></button></article>)}{snapshot.summary.delegatedRunCount > 0 && <article className={styles.observation}><p>{snapshot.summary.delegatedRunCount} of {snapshot.summary.runCount} selected runs are delegated agents.</p><button className={styles.inlineButton} type="button" onClick={(event) => onInspect("Delegated agents", snapshot.runs.filter((run) => run.scope === "delegated"), event.currentTarget)}>Inspect delegated agents <span aria-hidden="true">→</span></button></article>}</div><p className={styles.panelNote}>These observations describe retained evidence, not model performance, time worked, or spending.</p></section>;
}
