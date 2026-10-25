"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { SafeMarkdown } from "../../markdown/SafeMarkdown";
import { subscribeLiveEvents } from "../../../live-events";
import { ContinuedSessionNotice, ManagedTerminalPanel, ManagedTerminalSurface, terminalBridge, useManagedTerminals } from "./ManagedTerminalPanel";

type Position = { fingerprint: string; offset: number };
type Message = { kind: "owner" | "agent"; at: number | null; text: string }
  | { kind: "tool"; at: number | null; name: string; outcome: "completed" | "failed" | "pending" };
export type HistoryPage = { messages: Message[]; cursor: Position | null; older: Position | null; reset: boolean; status: "ok" | "missing" | "unsupported" };
type Request = { cursor?: Position; before?: Position; limit?: number };
type ContinueStatus = "started" | "cancelled" | "live" | "unknown" | "folder_missing" | "history_missing" | "cli_missing" | "busy" | "invalid" | "not_found" | "unavailable" | "failed";
type Bridge = { sessionHistory: (sessionId: string, request: Request) => Promise<{ ok: true; page: HistoryPage } | { ok: false }>; sessionContinue?: (sessionId: string) => Promise<{ status: ContinueStatus }>; openSessionLink?: (url: string) => Promise<{ ok: true } | { ok: false; error: "invalid" }> };
function bridge() {
  if (typeof window === "undefined") return undefined;
  const value = (window as Window & { pomegrDesktop?: Bridge }).pomegrDesktop;
  return typeof value?.sessionHistory === "function" ? value : undefined;
}
const subscribeBridge = () => () => {};
export function useSessionHistoryAvailability() {
  return useSyncExternalStore(subscribeBridge, () => bridge() ? "available" : "absent", () => "pending");
}

// Owner prompts read as a distinct block; a long one, such as a task prompt, folds after about eight lines.
const OWNER_FOLD_LINES = 8;
const OWNER_FOLD_CHARACTERS = 600;
function OwnerMessage({ text, onOpenLink }: { text: string; onOpenLink?: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > OWNER_FOLD_LINES || text.length > OWNER_FOLD_CHARACTERS;
  return <div className="sessionTerminalMessage sessionTerminalOwner">
    <span className="sessionTerminalOwnerLabel">You</span>
    <div className="sessionTerminalOwnerBody" data-folded={long && !open ? "true" : undefined}><SafeMarkdown text={text} onOpenLink={onOpenLink} /></div>
    {long && <button type="button" className="commandQuietAction sessionTerminalOwnerToggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
  </div>;
}

// Fetch-free rendering also supplies the synthetic design-system states.
export function SessionTerminalSurface({ page, busy, failed, live, onRefresh, onEarlier, outputRef, onScroll, onContinue, continuing, continueMessage, onOpenLink }: {
  page: HistoryPage | null; busy: boolean; failed: boolean; live: boolean;
  onRefresh: () => void; onEarlier: () => void;
  outputRef?: RefObject<HTMLDivElement | null>; onScroll?: () => void;
  onContinue?: () => void; continuing?: boolean; continueMessage?: string | null;
  onOpenLink?: (url: string) => void;
}) {
  return <section className="sessionTerminal" aria-label="Read-only session terminal">
    <div className="sessionTerminalOutput" aria-label="Saved session history" tabIndex={0} ref={outputRef} onScroll={onScroll} aria-busy={busy}>
      {page?.older && <button type="button" className="commandQuietAction" disabled={busy} onClick={onEarlier}>Load earlier</button>}
      {!page && !failed && <p role="status">Reading history…</p>}
      {page?.status === "missing" && <><p>The provider no longer has this session&apos;s history.</p><p className="sessionTerminalMuted">Pomegr keeps no separate copy.</p></>}
      {page?.status === "unsupported" && <p>This provider does not support reading session history.</p>}
      {page?.status === "ok" && (page.messages.length ? page.messages.map((message, index) => message.kind === "tool"
        ? <p key={index} className="sessionTerminalTool">{`Tool · ${message.name} · ${message.outcome}`}</p>
        : message.kind === "owner"
          ? <OwnerMessage key={index} text={message.text} onOpenLink={onOpenLink} />
          : <div key={index} className="sessionTerminalMessage"><SafeMarkdown text={message.text} onOpenLink={onOpenLink} /></div>) : <p>No messages yet</p>)}
      {failed && <p role="alert">Session history could not be read.</p>}
    </div>
    <div className="sessionTerminalBar">
      <span role={continueMessage ? "status" : undefined}>{continueMessage ?? (live ? "Read-only · Running outside Pomegr · Updates automatically" : "Read-only · Session ended")}</span>
      {live && <button type="button" className="commandQuietAction" disabled={busy} onClick={onRefresh}>Refresh</button>}
      {onContinue && <button type="button" className="commandQuietAction" disabled={continuing} onClick={onContinue}>{continuing ? "Continuing…" : "Continue"}</button>}
    </div>
  </section>;
}

const CONTINUE_REASONS: Record<Exclude<ContinueStatus, "started" | "cancelled">, string> = {
  live: "session is already running", unknown: "session ownership could not be confirmed", folder_missing: "working directory is missing",
  history_missing: "provider history is unavailable", cli_missing: "provider command is unavailable", busy: "another terminal action is in progress",
  invalid: "session cannot be continued", not_found: "session was not found", unavailable: "terminal host is unavailable", failed: "session could not be continued",
};
function HistoryPanel({ sessionId, live, onContinued, allowContinue = true }: { sessionId: string; live: boolean; onContinued?: () => void; allowContinue?: boolean }) {
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [continueMessage, setContinueMessage] = useState<string | null>(null);
  const output = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const read = useRef<(earlier?: boolean) => void>(() => {});

  useLayoutEffect(() => {
    const node = output.current;
    if (!node) return;
    if (prepend.current) {
      node.scrollTop = prepend.current.top + node.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (pinned.current) node.scrollTop = node.scrollHeight;
  }, [page]);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let current: HistoryPage | null = null;
    const visible = () => !disposed && document.visibilityState === "visible";
    const load = async (earlier = false) => {
      if (!visible()) return;
      if (inFlight) { queued = true; return; }
      const request: Request = earlier && current?.older ? { before: current.older } : current?.cursor ? { cursor: current.cursor } : {};
      inFlight = true;
      setBusy(true);
      try {
        const answer = await bridge()?.sessionHistory(sessionId, request);
        if (disposed) return;
        if (!answer?.ok) { setFailed(true); return; }
        const next = answer.page;
        const replace = !current || (!request.cursor && !request.before) || next.reset || next.status !== "ok";
        const node = output.current;
        if (earlier && !replace && node) prepend.current = { height: node.scrollHeight, top: node.scrollTop };
        current = replace ? next : earlier
          ? { ...next, messages: [...next.messages, ...current!.messages], cursor: current!.cursor }
          : { ...next, messages: [...current!.messages, ...next.messages], older: current!.older };
        setPage(current);
        setFailed(false);
      } catch { if (!disposed) setFailed(true); }
      finally {
        inFlight = false;
        if (!disposed) setBusy(false);
        if (queued) { queued = false; if (visible()) void load(); }
      }
    };
    read.current = (earlier) => { void load(earlier); };
    const unsubscribe = subscribeLiveEvents((event) => {
      if (event.type === "revision" && event.sessionId === sessionId && event.domain === "session-summary") void load();
      // A reconnect may have missed revisions; one read with the cursor catches up.
      else if (event.type === "connection" && event.state === "connected") void load();
    });
    const onVisible = () => { if (visible()) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    // Effect replay must dispose its first setup before any IPC read begins.
    queueMicrotask(() => { if (!current && !inFlight) void load(); });
    return () => { disposed = true; current = null; read.current = () => {}; unsubscribe(); document.removeEventListener("visibilitychange", onVisible); };
  }, [sessionId]);

  const canContinue = allowContinue && !live && !busy && !failed && page?.status === "ok" && /^(claude|codex):/u.test(sessionId)
    && typeof bridge()?.sessionContinue === "function" && Boolean(terminalBridge());
  const continueSession = async () => {
    const invoke = bridge()?.sessionContinue;
    if (!invoke || continuing) return;
    setContinuing(true); setContinueMessage(null);
    try {
      const result = await invoke(sessionId);
      if (result.status === "started") { onContinued?.(); return; }
      if (result.status !== "cancelled") setContinueMessage(`Read-only · Continue unavailable: ${CONTINUE_REASONS[result.status]}`);
    } catch { setContinueMessage("Read-only · Continue unavailable: terminal host is unavailable"); }
    finally { setContinuing(false); }
  };

  const openSessionLink = bridge()?.openSessionLink;
  return <>
  <SessionTerminalSurface page={page} busy={busy} failed={failed} live={live} outputRef={output}
    onOpenLink={typeof openSessionLink === "function" ? (url) => { void openSessionLink(url).catch(() => {}); } : undefined}
    onRefresh={() => read.current()} onEarlier={() => read.current(true)} onScroll={() => {
      const node = output.current;
      if (node) pinned.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 24;
    }} onContinue={canContinue && !continueMessage ? () => void continueSession() : undefined} continuing={continuing} continueMessage={canContinue ? continueMessage : null} />
  </>;
}

export function SessionTerminalPanel(props: { sessionId: string; live: boolean }) {
  const availability = useSessionHistoryAvailability();
  return availability === "available" ? terminalBridge() ? <ManagedSessionPanel key={props.sessionId} {...props} /> : <HistoryPanel key={props.sessionId} {...props} /> : null;
}

function ManagedSessionPanel({ sessionId, live }: { sessionId: string; live: boolean }) {
  const { listing, refresh } = useManagedTerminals();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [exited, setExited] = useState<{ key: string; code: number } | null>(null);
  const [continuing, setContinuing] = useState(false);
  const onContinued = async () => { setExited(null); setContinuing(true); try { await refresh(); } finally { setContinuing(false); } };
  const continuations = listing?.sessions?.filter((item) => item.continuedFrom === sessionId) ?? [];
  const newestContinuations = [...continuations].reverse();
  const continued = newestContinuations.find((item) => item.state === "live" && exited?.key !== item.key)
    ?? newestContinuations.find((item) => item.key === exited?.key)
    ?? newestContinuations[0];
  if (continued) {
    const exitCode = exited?.key === continued.key ? exited.code : continued.exitCode;
    if (continued.state === "exited" || exited?.key === continued.key) return <>
      <p className="sessionTerminalMuted">Process exited with code {exitCode ?? 0}.</p>
      <ContinuedSessionNotice terminal={continued} />
      <HistoryPanel sessionId={sessionId} live={false} onContinued={onContinued} allowContinue={!live && continued.sessionId === sessionId} />
    </>;
    return <ManagedTerminalPanel terminal={continued} onExit={(code) => setExited({ key: continued.key, code })} />;
  }
  if (continuing) return <ManagedTerminalSurface state="starting" />;
  const current = listing?.sessions?.find((item) => item.sessionId === sessionId);
  const siblings = current?.taskId ? listing?.sessions?.filter((item) => item.repositoryId === current.repositoryId && item.taskId === current.taskId) ?? [] : [];
  const terminal = siblings.find((item) => item.key === selectedKey) ?? current;
  const selector = siblings.length > 0 && <div className="sessionTerminalBar" role="group" aria-label="Task terminals">
    {siblings.map((item) => <button key={item.key} type="button" className="commandQuietAction" aria-pressed={item.key === terminal?.key} onClick={() => setSelectedKey(item.key)}>
      {item.taskId} <span className="commandChip">{item.role === "review" ? "Review" : "Build"}</span>
    </button>)}
  </div>;
  if (terminal && (exited?.key === terminal.key || terminal.state === "exited")) return <>
    {selector}
    <p className="sessionTerminalMuted">Process exited with code {(exited?.key === terminal.key ? exited.code : terminal.exitCode) ?? 0}.</p>
    {terminal.sessionId && <HistoryPanel key={terminal.key} sessionId={terminal.sessionId} live={false} onContinued={onContinued} allowContinue={!live && terminal === current} />}
  </>;
  if (terminal) return <>{selector}<ManagedTerminalPanel key={terminal.key} terminal={terminal} onExit={(code) => setExited({ key: terminal.key, code })} /></>;
  if (!listing) return <ManagedTerminalSurface state="reconnecting" />;
  if (!listing.ok) return <ManagedTerminalSurface state="host_unavailable" />;
  return <>
    {listing.hosts?.some((host) => host.state === "incompatible_host") && <p className="sessionTerminalMuted">An older terminal host is temporarily inaccessible.</p>}
    <HistoryPanel sessionId={sessionId} live={live} onContinued={onContinued} />
  </>;
}
