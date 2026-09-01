"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { AgentsRun } from "../../../shared/agents-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { relativeTime, sessionListTime } from "../../dashboard-utils";
import { CommandIcon } from "../command-center/CommandPage";
import { DottedInfoPopover } from "../DottedInfoPopover";
import styles from "./AgentsView.module.css";

function sessionHref(run: AgentsRun) {
  try {
    return `/sessions/${encodeSessionRoute(run.sessionId)}`;
  } catch {
    return "/sessions";
  }
}

function statusLabel(status: AgentsRun["status"]) {
  return status === "needs_input" ? "Needs input" : status.replace(/_/g, " ").replace(/^./, (value) => value.toUpperCase());
}

function contextLabel(value: number | null) {
  return value === null ? "—" : `${Math.round(value / 1_000)}k`;
}

export function AgentEvidencePanel({ selection, onClose }: { selection: { title: string; runs: AgentsRun[] } | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const explanationRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!selection) return;
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      // Let the shared disclosure dismiss first, keeping its parent panel open.
      if (event.key === "Escape" && !explanationRef.current?.querySelector('[aria-expanded="true"]')) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, selection]);
  if (!selection) return null;
  const unreportedModel = selection.runs.length > 0 && selection.runs.every((run) => run.model === null);

  return <aside className={styles.inspector} aria-label={`${selection.title} evidence`} role="dialog">
    <header className={styles.inspectorHead}>
      <div><h2>{selection.title}</h2><p>{selection.runs.length} observed agent {selection.runs.length === 1 ? "run" : "runs"}</p></div>
      <button ref={closeRef} className={styles.iconButton} type="button" onClick={onClose} aria-label="Close evidence"><CommandIcon name="close" /></button>
    </header>
    <div className={styles.inspectorContent}>
      <p className={styles.evidenceNote} ref={explanationRef}>
        {unreportedModel ? <DottedInfoPopover
          ariaLabel="Why is the model unreported?"
          content={<>
            <span>A run is counted when an agent is observed, even without a model response.</span>
            <span>The model may be unreported because no response was recorded, only an API error was recorded, or model metadata was not captured by Pomegr.</span>
            <span>A requested model does not confirm which model actually ran.</span>
          </>}
        >Why is the model unreported?</DottedInfoPopover> : "Supporting retained agent evidence for the current selection."}
      </p>
      {selection.runs.map((run) => <article className={styles.evidenceRun} key={run.id}>
        <h3>{run.assignment || run.label}</h3>
        <p>{run.project} / {run.sessionTitle}</p>
        <p>{run.model || "Model unavailable"} · {run.role.replace(/-/g, " ")} · {run.scope === "main" ? "Main agent" : "Delegated agent"}</p>
        <dl className={styles.evidenceMeta}>
          <div><dt>Recorded state</dt><dd>{statusLabel(run.status)}</dd></div>
          <div><dt>Latest context</dt><dd className={styles.dataValue}>{contextLabel(run.latestContextTotal)}</dd></div>
          <div><dt>Last activity</dt><dd>{run.lastSeen ? <time dateTime={run.lastSeen} title={sessionListTime(run.lastSeen)}>{relativeTime(run.lastSeen)}</time> : "—"}</dd></div>
          <div><dt>Execution tasks</dt><dd className={styles.dataValue}>{run.executionTaskCount ?? "—"}</dd></div>
        </dl>
        <Link href={sessionHref(run)} className={styles.evidenceLink}>Open parent session <CommandIcon name="arrow" size="small" /></Link>
      </article>)}
    </div>
  </aside>;
}
