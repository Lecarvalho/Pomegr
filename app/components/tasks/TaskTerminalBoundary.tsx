"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ManagedTerminalPanel, ManagedTerminalSurface, terminalBridge, useManagedTerminals, type ManagedTerminal } from "../dashboard/session-terminal/ManagedTerminalPanel";
import { startDesktopTask } from "./task-desktop";
import { taskSessionHref } from "./task-presentation";

export const TASK_TERMINAL_OPEN = "pomegr-task-terminal-open";
type StartView = { repositoryId: string; taskId: string; status: "started" | "failed" };
const Terminals = createContext<{ repositoryId: string; sessions: ManagedTerminal[] } | null>(null);
const taskHref = (repositoryId: string, taskId: string) => `/tasks?repository=${encodeURIComponent(repositoryId)}&terminal=${encodeURIComponent(taskId)}`;

export function TaskTerminalHint({ taskId }: { taskId: string }) {
  const context = useContext(Terminals);
  const terminal = context?.sessions.find((item) => item.taskId === taskId && item.role !== "review" && item.repositoryId === context.repositoryId && item.state === "starting" && !item.sessionId);
  return terminal && context ? <p className="taskCardDetail"><Link className="commandTextLink" href={taskHref(context.repositoryId, taskId)}>Waiting in terminal</Link></p> : null;
}

// This view is entered by the owner's manual start or its link, never by queue discovery.
export function TaskTerminalBoundary({ repositoryId, revision, children }: { repositoryId: string; revision: unknown; children: ReactNode }) {
  const available = useSyncExternalStore(() => () => {}, () => !!terminalBridge(), () => false);
  return available ? <DesktopTaskTerminal repositoryId={repositoryId} revision={revision}>{children}</DesktopTaskTerminal> : children;
}

function DesktopTaskTerminal({ repositoryId, revision, children }: { repositoryId: string; revision: unknown; children: ReactNode }) {
  const router = useRouter();
  const address = useSearchParams().toString();
  const route = useRef(router);
  useEffect(() => { route.current = router; }, [router]);
  const { listing, refresh } = useManagedTerminals(revision);
  const [selected, setSelected] = useState<StartView | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const routed = useRef<string | null>(null);
  useEffect(() => {
    if (!terminalBridge()) return;
    const readAddress = () => {
      const query = new URLSearchParams(window.location.search);
      const id = query.get("terminal");
      setSelected(query.get("repository") === repositoryId && /^T-[1-9][0-9]{0,8}$/u.test(id ?? "") ? { repositoryId, taskId: id!, status: "started" } : null);
    };
    const open = (event: Event) => {
      const next = (event as CustomEvent<StartView>).detail;
      if (next.repositoryId !== repositoryId) return;
      setSelected(next); setExitCode(null); refresh();
      route.current.replace(taskHref(repositoryId, next.taskId), { scroll: false });
    };
    readAddress();
    window.addEventListener(TASK_TERMINAL_OPEN, open);
    window.addEventListener("popstate", readAddress);
    return () => { window.removeEventListener(TASK_TERMINAL_OPEN, open); window.removeEventListener("popstate", readAddress); };
    // The bridge is fixed for this renderer; board revisions refresh discovery without replacing the entry listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryId]);
  useEffect(() => {
    let disposed = false;
    const query = new URLSearchParams(address);
    const id = query.get("terminal");
    queueMicrotask(() => {
      if (disposed) return;
      if (query.get("repository") === repositoryId && /^T-[1-9][0-9]{0,8}$/u.test(id ?? "")) {
        setSelected((previous) => previous?.taskId === id ? previous : { repositoryId, taskId: id!, status: "started" });
      } else setSelected(null);
    });
    return () => { disposed = true; };
  }, [address, repositoryId]);
  const candidates = selected ? listing?.sessions?.filter((item) => item.repositoryId === repositoryId && item.taskId === selected.taskId && item.role !== "review" && (item.state !== "exited" || !item.sessionId)) ?? [] : [];
  const terminal = candidates.findLast((item) => item.state !== "exited") ?? candidates.at(-1);
  useEffect(() => {
    const href = terminal?.sessionId && taskSessionHref(terminal.sessionId);
    if (!href || routed.current === href) return;
    routed.current = href;
    router.replace(`${href}?tab=terminal`, { scroll: false });
  }, [terminal?.sessionId, router]);
  if (!selected) return <Terminals.Provider value={{ repositoryId, sessions: listing?.sessions ?? [] }}>{children}</Terminals.Provider>;
  return <section className="commandView taskTerminalStart" aria-label={`Starting ${selected.taskId}`}>
    <div className="commandPageHeading"><h1>Starting {selected.taskId}</h1>
      <button type="button" className="commandQuietAction" onClick={() => { setSelected(null); router.replace(`/tasks?repository=${encodeURIComponent(repositoryId)}`, { scroll: false }); }}>Back to tasks</button>
    </div>
    {exitCode !== null || terminal?.state === "exited" ? <p className="sessionTerminalMuted">Process exited with code {exitCode ?? terminal?.exitCode ?? 0}.</p>
      : terminal ? <ManagedTerminalPanel key={terminal.key} terminal={terminal} onExit={setExitCode} />
      : <ManagedTerminalSurface state={selected.status === "failed" ? "failed" : listing?.ok === false ? "host_unavailable" : "starting"}
        onRetry={selected.status === "failed" ? () => {
          setSelected({ ...selected, status: "started" });
          void startDesktopTask(repositoryId, selected.taskId).then((status) => { if (status !== "started") setSelected({ ...selected, status: "failed" }); });
        } : undefined} />}
  </section>;
}
