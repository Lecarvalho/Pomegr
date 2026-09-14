import { afterEach, describe, expect, it, vi } from "vitest";

class LiveEventSource {
  static instances: LiveEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    LiveEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (typeof listener !== "function") return;
    const current = this.listeners.get(type) || new Set();
    current.add(listener as (event: Event) => void);
    this.listeners.set(type, current);
  }

  open() { this.dispatch("open", new Event("open")); }
  error() { this.dispatch("error", new Event("error")); }
  emit(type: string, value: unknown) { this.dispatch(type, new MessageEvent(type, { data: JSON.stringify(value) })); }
  close() { this.closed = true; }

  private dispatch(type: string, event: Event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

async function transport() {
  vi.stubGlobal("EventSource", LiveEventSource);
  return import("../../app/live-events");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  LiveEventSource.instances = [];
});

describe("shared live event transport", () => {
  it("uses one ref-counted stream and only becomes connected after a real open", async () => {
    const live = await transport();
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = live.subscribeLiveEvents(first);
    const releaseSecond = live.subscribeLiveEvents(second);

    expect(LiveEventSource.instances).toHaveLength(1);
    expect(LiveEventSource.instances[0].url).toBe("/api/events");
    expect(live.liveEventConnectionState()).toBe("reconnecting");
    expect(first).toHaveBeenLastCalledWith({ type: "connection", state: "reconnecting", epoch: 1 });
    expect(second).toHaveBeenLastCalledWith({ type: "connection", state: "reconnecting", epoch: 1 });

    LiveEventSource.instances[0].open();
    expect(live.liveEventConnectionState()).toBe("connected");
    expect(first).toHaveBeenLastCalledWith({ type: "connection", state: "connected", epoch: 1 });
    expect(second).toHaveBeenLastCalledWith({ type: "connection", state: "connected", epoch: 1 });
    const callsAfterOpen = first.mock.calls.length;
    LiveEventSource.instances[0].open();
    expect(first).toHaveBeenCalledTimes(callsAfterOpen);

    releaseFirst();
    expect(LiveEventSource.instances[0].closed).toBe(false);
    releaseSecond();
    expect(LiveEventSource.instances[0].closed).toBe(true);
    expect(live.liveEventConnectionState()).toBe("reconnecting");
  });

  it("keeps only the latest revision for each domain/session during an epoch", async () => {
    const live = await transport();
    const listener = vi.fn();
    const release = live.subscribeLiveEvents(listener);
    const source = LiveEventSource.instances[0];
    source.open();
    listener.mockClear();

    source.emit("history", { domain: "history", sessionId: "claude:one", revision: 5 });
    source.emit("history", { domain: "history", sessionId: "claude:one", revision: 5 });
    source.emit("history", { domain: "history", sessionId: "claude:one", revision: 4 });
    source.emit("history", { domain: "history", sessionId: "claude:one", revision: 6, total: 9 });
    source.emit("history", { domain: "history", sessionId: "claude:two", revision: 1 });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "revision", domain: "history", sessionId: "claude:one", revision: 5, epoch: 1 },
      { type: "revision", domain: "history", sessionId: "claude:one", revision: 6, total: 9, epoch: 1 },
      { type: "revision", domain: "history", sessionId: "claude:two", revision: 1, epoch: 1 },
    ]);
    release();
  });

  it("starts a fresh revision epoch after recovery and ignores closed-stream events", async () => {
    vi.useFakeTimers();
    const live = await transport();
    const listener = vi.fn();
    const release = live.subscribeLiveEvents(listener);
    const first = LiveEventSource.instances[0];
    first.open();
    listener.mockClear();
    first.emit("history", { domain: "history", sessionId: "claude:one", revision: 8 });
    first.error();
    first.emit("history", { domain: "history", sessionId: "claude:one", revision: 9 });

    expect(first.closed).toBe(true);
    expect(live.liveEventConnectionState()).toBe("reconnecting");
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "revision", domain: "history", sessionId: "claude:one", revision: 8, epoch: 1 },
      { type: "connection", state: "reconnecting", epoch: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(250);
    const second = LiveEventSource.instances[1];
    second.emit("history", { domain: "history", sessionId: "claude:one", revision: 1 });
    expect(listener).toHaveBeenLastCalledWith({ type: "revision", domain: "history", sessionId: "claude:one", revision: 1, epoch: 2 });
    release();
  });

  it("keeps never-open streams in reconnecting recovery state and cancels a pending reconnect on final release", async () => {
    vi.useFakeTimers();
    const live = await transport();
    const listener = vi.fn();
    const release = live.subscribeLiveEvents(listener);
    const source = LiveEventSource.instances[0];

    expect(live.liveEventConnectionState()).toBe("reconnecting");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith({ type: "connection", state: "reconnecting", epoch: 1 });
    source.error();
    expect(listener).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(LiveEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(true);
  });

  it("bounds retained revision keys while preserving rejection for recent active sessions", async () => {
    const live = await transport();
    const listener = vi.fn();
    const release = live.subscribeLiveEvents(listener);
    const source = LiveEventSource.instances[0];
    source.open();
    listener.mockClear();

    for (let index = 0; index < 300; index += 1) {
      source.emit("history", { domain: "history", sessionId: `claude:session-${index}`, revision: 1 });
    }
    const publications = listener.mock.calls.length;
    source.emit("history", { domain: "history", sessionId: "claude:session-299", revision: 0 });
    expect(listener).toHaveBeenCalledTimes(publications);
    release();
  });
});
