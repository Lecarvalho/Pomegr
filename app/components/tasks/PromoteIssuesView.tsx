"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { useTasks } from "../../tasks-store";
import { CommandPageHeader } from "../command-center/CommandPage";
import { TaskModal } from "./TaskModal";
import { BackToTasks } from "./promote-issues-action";
import { DESKTOP_ONLY_NOTICE, EMPTY_NOTICE, LOADING_NOTICE, PROMOTE_ISSUES_CAPTION, issueCountLine, issuesNotice, type IssuesNotice } from "./promote-issues-model";
import { IssuesState, PromoteIssuesSplit } from "./promote-issues-split";
import type { TaskIssue } from "./task-issues-desktop";
import { usePromoteIssues } from "./use-promote-issues";

export function PromoteIssuesMissing() {
  const headingId = useId();
  return <section className="commandView promoteIssuesPage" aria-labelledby={headingId}>
    <CommandPageHeader headingId={headingId} title="Promote issues" breadcrumb={<BackToTasks />} />
    <div className="promoteIssuesPanel">
      <IssuesState notice={{ title: "Choose a repository", detail: "Open Promote issues from the Tasks page of a repository." }} />
    </div>
  </section>;
}

/** The Promote issues page (`/tasks/issues?repository=<id>`). */
export function PromoteIssuesView({ repositoryId }: { repositoryId: string }) {
  const headingId = useId();
  const { snapshot, loading } = useRepositoryInventory();
  const { board, refresh } = useTasks(repositoryId);
  const issues = usePromoteIssues(repositoryId);
  const [promoting, setPromoting] = useState<number | null>(null);
  const [goneIssue, setGoneIssue] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const latest = useRef(issues);
  const waiting = useRef<Array<() => void>>([]);
  const name = snapshot.repositories.find((repository) => repository.id === repositoryId)?.displayName ?? null;
  const { availability, list, failed, reading, refresh: readAgain } = issues;
  const available = availability === "available";
  const modalIssue = available && list?.status === "ok" && promoting !== null ? list.issues.find((issue) => issue.number === promoting) ?? null : null;
  const modalOpen = modalIssue !== null;
  // The count line names the repository, so it waits for the inventory instead of gaining the name a moment later.
  const countLine = available && list?.status === "ok" && (name !== null || !(loading || snapshot.readiness === "loading")) ? issueCountLine(name, list) : null;

  useEffect(() => { latest.current = issues; });
  useEffect(() => {
    if (reading || waiting.current.length === 0) return;
    const done = waiting.current;
    waiting.current = [];
    for (const resolve of done) resolve();
  }, [reading]);
  useEffect(() => {
    // Closing by any route (Cancel, Escape, a promoted issue) returns focus to the Promote button, else to the chosen row.
    if (wasOpen.current && !modalOpen) {
      const target = opener.current?.isConnected && !(opener.current as HTMLButtonElement).disabled
        ? opener.current : document.querySelector<HTMLElement>('.promoteIssueRow[aria-pressed="true"]');
      target?.focus({ preventScroll: true });
    }
    wasOpen.current = modalOpen;
  }, [modalOpen]);

  const promote = useCallback((issue: TaskIssue) => {
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setGoneIssue(null);
    setPromoting(issue.number);
  }, []);
  const close = useCallback(() => setPromoting(null), []);
  const refreshList = useCallback(() => { setGoneIssue(null); readAgain(); }, [readAgain]);
  const reload = useCallback(async (number: number) => {
    await new Promise<void>((resolve) => { waiting.current.push(resolve); readAgain(); });
    const next = latest.current.list;
    if (next?.status === "ok" && next.issues.some((issue) => issue.number === number)) return;
    setPromoting(null);
    if (next?.status === "ok") setGoneIssue(number);
  }, [readAgain]);
  const promoted = useCallback(() => { readAgain(); }, [readAgain]);

  let notice: IssuesNotice | null = null;
  if (available) {
    if (!list) notice = failed ? issuesNotice("failed") : LOADING_NOTICE;
    else if (list.status !== "ok") notice = issuesNotice(list.status);
    else if (list.issues.length === 0) notice = EMPTY_NOTICE;
  }
  const showList = available && list?.status === "ok" && list.issues.length > 0;

  return <section className="commandView promoteIssuesPage" aria-labelledby={headingId} aria-busy={reading || undefined}>
    <CommandPageHeader headingId={headingId} title="Promote issues" breadcrumb={<BackToTasks repositoryId={repositoryId} />}
      meta={countLine && <p className="promoteIssuesCount">{countLine}</p>}
      actions={available && <button type="button" className="commandQuietAction" disabled={reading} onClick={refreshList}>Refresh</button>} />
    {availability === "absent" && <div className="promoteIssuesPanel"><IssuesState notice={DESKTOP_ONLY_NOTICE} /></div>}
    {available && <div className="promoteIssuesPanel">
      <p className="promoteIssuesCaption">{PROMOTE_ISSUES_CAPTION}</p>
      {goneIssue !== null && <p className="promoteIssuesCaption" role="status">Issue #{goneIssue} is no longer open.</p>}
      {failed && list && <p className="newTaskError promoteIssuesError" role="alert">Pomegr could not refresh the issues. The list shown is from the last read.</p>}
      {notice && <IssuesState notice={notice} />}
      {showList && list && <PromoteIssuesSplit repositoryId={repositoryId} issues={list.issues} truncated={list.truncated} selected={issues.issue} onSelect={issues.select} onPromote={promote} />}
    </div>}
    {modalIssue && <TaskModal key={modalIssue.number} mode="issue" repositoryId={repositoryId} repositoryName={name} issue={modalIssue} board={board} refresh={refresh}
      onReload={() => reload(modalIssue.number)} onPromoted={promoted} onClose={close} />}
  </section>;
}
