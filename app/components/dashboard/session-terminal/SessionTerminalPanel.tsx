"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { SafeMarkdown } from "../../markdown/SafeMarkdown";
import { subscribeLiveEvents } from "../../../live-events";

type Position = { fingerprint: string; offset: number };
type Message = { kind: "owner" | "agent"; at: number | null; text: string }
  | { kind: "tool"; at: number | null; name: string; outcome: "completed" | "failed" | "pending" };
export type HistoryPage = { messages: Message[]; cursor: Position | null; older: Position | null; reset: boolean; status: "ok" | "missing" | "unsupported" };
type Request = { cursor?: Position; before?: Position; limit?: number };
type Bridge = { sessionHistory: (sessionId: string, request: Request) => Promise<{ ok: true; page: HistoryPage } | { ok: false }> };
function bridge() {
  if (typeof window === "undefined") return undefined;
  const value = (window as Window & { pomegrDesktop?: Bridge }).pomegrDesktop;
  return typeof value?.sessionHistory === "function" ? value : undefined;
}
const subscribeBridge = () => () => {};
export function useSessionHistoryAvailability() {
  return useSyncExternalStore(subscribeBridge, () => bridge() ? "available" : "absent", () => "pending");
}

// Fetch-free rendering also supplies the synthetic design-system states.
export function SessionTerminalSurface({ page, busy, failed, live, onRefresh, onEarlier, outputRef, onScroll }: {
  page: HistoryPage | null; busy: boolean; failed: boolean; live: boolean;
  onRefresh: () => void; onEarlier: () => void;
  outputRef?: RefObject<HTMLDivElement | null>; onScroll?: () => void;
}) {
  return <section className="sessionTerminal" aria-label="Read-only session terminal">
    <div className="sessionTerminalOutput" aria-label="Saved session history" tabIndex={0} ref={outputRef} onScroll={onScroll} aria-busy={busy}>
      {page?.older && <button type="button" className="commandQuietAction" disabled={busy} onClick={onEarlier}>Load earlier</button>}
      {!page && !failed && <p role="status">Reading history…</p>}
      {page?.status === "missing" && <><p>The provider no longer has this session&apos;s history.</p><p className="sessionTerminalMuted">Pomegr keeps no separate copy.</p></>}
      {page?.status === "unsupported" && <p>This provider does not support reading session history.</p>}
      {page?.status === "ok" && (page.messages.length ? page.messages.map((message, index) => message.kind === "tool"
        ? <p key={index} className="sessionTerminalTool">{`Tool · ${message.name} · ${message.outcome}`}</p>
        : <div key={index} className="sessionTerminalMessage">
          {message.kind === "owner" && <span className="sessionTerminalMuted">{"> "}</span>}
          <SafeMarkdown text={message.text} />
        </div>) : <p>No messages yet</p>)}
      {failed && <p role="alert">Session history could not be read.</p>}
    </div>
    <div className="sessionTerminalBar">
      <span>{live ? "Read-only · Running outside Pomegr · Updates automatically" : "Read-only · Session ended"}</span>
      {live && <button type="button" className="commandQuietAction" disabled={busy} onClick={onRefresh}>Refresh</button>}
    </div>
  </section>;
}

function HistoryPanel({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
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

  return <SessionTerminalSurface page={page} busy={busy} failed={failed} live={live} outputRef={output}
    onRefresh={() => read.current()} onEarlier={() => read.current(true)} onScroll={() => {
      const node = output.current;
      if (node) pinned.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 24;
    }} />;
}

export function SessionTerminalPanel(props: { sessionId: string; live: boolean }) {
  const availability = useSessionHistoryAvailability();
  return availability === "available" ? <HistoryPanel key={props.sessionId} {...props} /> : null;
}
