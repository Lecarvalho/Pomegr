"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { subscribeLiveEvents } from "../../../live-events";
import { encodeSessionRoute } from "../../../../shared/session-route.mjs";
import "@xterm/xterm/css/xterm.css";

export type ManagedTerminal = { key: string; repositoryId: string | null; taskId: string | null; role?: "build" | "review"; sessionId: string | null; continuedFrom?: string; state: "starting" | "live" | "exited" | "host_unavailable"; exitCode?: number };
type TerminalEvent = { attachId: string; event: "output" | "exit" | "detached"; data?: string; replay?: boolean; exitCode?: number; reason?: string };
type Answer = { ok: boolean; status: string; readOnly?: boolean; sessions?: ManagedTerminal[]; hosts?: { state: string }[] };
type TerminalBridge = { terminal(operation: string, payload?: Record<string, unknown>): Promise<Answer>; onTerminalOutput(callback: (event: TerminalEvent) => void): () => void };
export function terminalBridge(): TerminalBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { pomegrDesktop?: TerminalBridge }).pomegrDesktop;
  return typeof bridge?.terminal === "function" && typeof bridge?.onTerminalOutput === "function" ? bridge : undefined;
}

// Discovery follows the revisions already supplied by observation; output stays in xterm only.
export function useManagedTerminals(revision?: unknown) {
  const [listing, setListing] = useState<Answer | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const previousRevision = useRef(revision);
  useEffect(() => {
    const bridge = terminalBridge();
    if (!bridge) return;
    let disposed = false, reading = false, queued = false;
    const read = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      if (reading) { queued = true; return; }
      reading = true;
      try {
        const answer = await bridge.terminal("list");
        if (!disposed) setListing(answer.ok ? answer : { ok: false, status: "host_unavailable", sessions: [] });
      } catch { if (!disposed) setListing({ ok: false, status: "host_unavailable", sessions: [] }); }
      finally { reading = false; if (queued) { queued = false; void read(); } }
    };
    refresh.current = read;
    const unsubscribe = subscribeLiveEvents((event) => {
      if ((event.type === "revision" && (event.domain === "session-summary" || event.domain === "sessions")) || (event.type === "connection" && event.state === "connected")) void read();
    });
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    queueMicrotask(() => { if (!reading) void read(); });
    return () => { disposed = true; refresh.current = async () => {}; unsubscribe(); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => { if (previousRevision.current !== revision) { previousRevision.current = revision; refresh.current(); } }, [revision]);
  return { listing, refresh: () => refresh.current() };
}

export type TerminalViewState = "starting" | "live" | "reconnecting" | "host_unavailable" | "incompatible_host" | "failed";
const LINES: Record<TerminalViewState, string> = {
  starting: "Waiting for the session to report",
  live: "Connected · desktop only",
  reconnecting: "Reconnecting to terminal… Input is unavailable until the connection returns.",
  host_unavailable: "Reconnection unavailable. The session may still be running.",
  incompatible_host: "This session runs in an older host and is temporarily inaccessible.",
  failed: "The session could not be started.",
};

export function ManagedTerminalSurface({ state, children, onRetry }: { state: TerminalViewState; children?: ReactNode; onRetry?: () => void }) {
  return <section className="sessionTerminal sessionManagedTerminal" aria-label="Session terminal">
    <div className="sessionManagedScreen">{children}</div>
    <div className="sessionTerminalBar"><span role="status">{LINES[state]}</span>
      {state === "failed" && onRetry && <button type="button" className="commandQuietAction" onClick={onRetry}>Start session again</button>}
    </div>
  </section>;
}

export function ContinuedSessionNotice({ terminal }: { terminal: ManagedTerminal }) {
  if (!terminal.continuedFrom || !terminal.sessionId || terminal.continuedFrom === terminal.sessionId) return null;
  return <p className="sessionTerminalMuted">This session continued as a new session. <a href={`/sessions/${encodeSessionRoute(terminal.sessionId)}?tab=terminal`}>Open continued session</a></p>;
}

export function ManagedTerminalPanel({ terminal, onExit }: { terminal: ManagedTerminal; onExit?: (code: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const focus = useRef<() => void>(() => {});
  const exited = useRef(onExit);
  useEffect(() => { exited.current = onExit; }, [onExit]);
  const [state, setState] = useState<TerminalViewState>(terminal.state === "host_unavailable" ? "host_unavailable" : "reconnecting");
  useEffect(() => {
    const bridge = terminalBridge();
    const node = container.current;
    if (!bridge || !node) return;
    let disposed = false, attached = false, writable = false, disconnected = false, readOnly = true;
    let replayWrites = 0;
    let cleanup = () => {};
    const attachId = `view-${crypto.randomUUID()}`;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed) return;
      const style = getComputedStyle(node);
      const fontFamily = [...style.fontFamily.split(",").map((family) => family.trim()).filter((family) => {
        const name = family.replace(/^["']|["']$/g, "");
        return name && !/Fallback$/i.test(name) && !/^(Consolas|monospace|sans-serif|serif|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|cursive|fantasy|math|fangsong)$/i.test(name);
      }), "Consolas", "monospace"].join(", ");
      const fontsReady = Promise.resolve().then(() => document.fonts?.load(`${style.fontSize} ${fontFamily}`))
        .then(() => document.fonts?.ready).catch(() => {});
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 500);
        void fontsReady.then(() => { clearTimeout(timeout); resolve(); });
      });
      if (disposed) return;
      const token = (name: string) => style.getPropertyValue(name).trim();
      const theme = () => ({ background: token("--command-ground"), foreground: token("--command-ink"), cursor: token("--command-ink"),
        selectionBackground: token("--command-panel-2"), black: token("--command-ground"), red: token("--command-error"), green: token("--command-green"),
        yellow: token("--command-amber"), blue: token("--command-blue"), magenta: token("--command-brand-text"), cyan: token("--command-blue"), white: token("--command-ink"),
        brightBlack: token("--command-muted"), brightRed: token("--command-error"), brightGreen: token("--command-green"), brightYellow: token("--command-amber"),
        brightBlue: token("--command-blue"), brightMagenta: token("--command-brand-text"), brightCyan: token("--command-blue"), brightWhite: token("--command-ink") });
      const emulator = new Terminal({ allowProposedApi: false, disableStdin: true, cursorBlink: true, scrollback: 5000,
        fontFamily, fontSize: parseFloat(style.fontSize), lineHeight: 1.4, theme: theme() });
      const fit = new FitAddon(); emulator.loadAddon(fit); emulator.open(node);
      focus.current = () => emulator.focus();
      const send = (operation: string, payload: Record<string, unknown>): Promise<Answer> => bridge.terminal(operation, payload).catch(() => ({ ok: false, status: "host_unavailable" }));
      const disconnect = () => {
        disconnected = true; writable = false; emulator.options.disableStdin = true;
        if (!disposed) setState("host_unavailable");
        void send("detach", { attachId });
      };
      const ready = () => {
        if (!attached || replayWrites > 0 || disposed || disconnected) return;
        writable = !readOnly; emulator.options.disableStdin = !writable;
        setState("live");
      };
      const resize = () => {
        if (!node.clientWidth || !node.clientHeight) return;
        fit.fit();
        if (attached) void send("resize", { attachId, cols: emulator.cols, rows: emulator.rows });
      };
      const remeasure = () => {
        if (disposed || disconnected) return;
        // xterm 6 ignores unchanged options; a family change also clears its DOM width cache.
        emulator.options.fontFamily = "monospace";
        emulator.options.fontFamily = fontFamily;
        resize();
      };
      void fontsReady.then(remeasure);
      document.fonts?.addEventListener("loadingdone", remeasure, { once: true });
      let input = Promise.resolve();
      const data = emulator.onData((value) => {
        if (!writable || replayWrites > 0) return;
        // JSON escaping and UTF-8 expansion still fit the host's 16 KiB input frame.
        let chunk = "";
        const append = (part: string) => {
          input = input.then(async () => {
            if (!writable || disposed) return;
            const answer = await send("input", { attachId, data: part });
            if (!answer.ok) disconnect();
          });
        };
        for (const character of value) {
          if (chunk.length + character.length > 2048) { append(chunk); chunk = ""; }
          chunk += character;
        }
        if (chunk) append(chunk);
      });
      let pendingReplayOutput = 0, pendingLiveOutput = 0;
      const unsubscribe = bridge.onTerminalOutput((event) => {
        if (event.attachId !== attachId || disposed || disconnected) return;
        if (event.event === "output" && typeof event.data === "string") {
          const size = new TextEncoder().encode(event.data).length;
          const replay = event.replay === true;
          if (replay ? pendingReplayOutput + size > 4 * 1024 * 1024 : pendingLiveOutput + size > 256 * 1024) { disconnect(); return; }
          if (replay) pendingReplayOutput += size;
          else pendingLiveOutput += size;
          if (replay) replayWrites++;
          emulator.write(event.data, () => {
            if (replay) pendingReplayOutput -= size;
            else pendingLiveOutput -= size;
            if (replay) { replayWrites--; ready(); }
          });
        }
        else if (event.event === "exit") { disconnected = true; writable = false; emulator.options.disableStdin = true; exited.current?.(event.exitCode ?? 0); }
        else if (event.event === "detached") disconnect();
      });
      const observer = new ResizeObserver(resize); observer.observe(node);
      const colors = new MutationObserver(() => { emulator.options.theme = theme(); });
      colors.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      cleanup = () => { writable = false; focus.current = () => {}; document.fonts?.removeEventListener("loadingdone", remeasure); observer.disconnect(); colors.disconnect(); unsubscribe(); data.dispose(); emulator.dispose(); void send("detach", { attachId }); };
      fit.fit();
      const answer = await send("attach", { key: terminal.key, attachId });
      if (disposed) { void send("detach", { attachId }); return; }
      if (disconnected) return;
      if (!answer.ok) { setState(answer.status === "incompatible_host" ? "incompatible_host" : "host_unavailable"); return; }
      attached = true; readOnly = answer.readOnly === true;
      ready();
      resize();
    })().catch(() => { if (!disposed) setState("host_unavailable"); });
    return () => { disposed = true; cleanup(); };
  }, [terminal.key, terminal.state]);
  return <>
    <ContinuedSessionNotice terminal={terminal} />
    <ManagedTerminalSurface state={state === "live" && terminal.state === "starting" ? "starting" : state}>
      <div ref={container} className="sessionTerminalEmulator" aria-label="Live session terminal" onClick={() => focus.current()} />
    </ManagedTerminalSurface>
  </>;
}
