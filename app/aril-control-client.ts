"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { THREAD_LIMIT_MEGABYTES, type ArilControlOperationName, type ArilSwitchState, type OwnerMemory, type ThreadFlushed, type ThreadSpace } from "../shared/agent-chat-contract";
import { useClientAccess } from "./hooks/ClientAccessContext";

// Client of Aril's own controls: the On/Off switch, the owner's memory, the space each thread takes, and its limit. The desktop app owns them: this
// module only asks, through the desktop bridge in the app window or through the paired-device route on a phone. Nothing is kept in browser storage.

export type ArilControlAvailability = "pending" | "desktop" | "paired" | "absent";

// An open view asks for the switch at this pace, so a switch turned elsewhere (the other device) reaches it.
const POLL_MS = 5_000;
const PAIRED_PATH = "/api/agent-chat";

type Json = Record<string, unknown>;
type Bridge = { arilControl(operation: ArilControlOperationName, payload: unknown): Promise<unknown> };

function bridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as Window & { pomegrDesktop?: Partial<Bridge> }).pomegrDesktop;
  return typeof candidate?.arilControl === "function" ? candidate as Bridge : undefined;
}

const subscribeBridge = () => () => {};
const record = (value: unknown): Json | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null);

/** Where the controls can be reached from this client, decided once so a control is never drawn and then taken away. */
export function useArilControlAvailability(): ArilControlAvailability {
  const desktop = useSyncExternalStore<"pending" | "yes" | "no">(subscribeBridge, () => (bridge() ? "yes" : "no"), () => "pending");
  const { mode } = useClientAccess();
  if (desktop === "yes") return "desktop";
  if (desktop === "pending" || mode === "unknown") return "pending";
  return mode === "lan" ? "paired" : "absent";
}

async function request(operation: ArilControlOperationName, payload: Json): Promise<Json | null> {
  try {
    const desktop = bridge();
    if (desktop) return record(await desktop.arilControl(operation, payload));
    const response = await fetch(PAIRED_PATH, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, payload }) });
    return response.ok ? record(await response.json().catch(() => null)) : null;
  } catch {
    return null;
  }
}

const reachable = (availability: ArilControlAvailability) => availability === "desktop" || availability === "paired";

function switchOf(answer: Json | null): ArilSwitchState | null {
  return answer?.ok === true && typeof answer.on === "boolean" && typeof answer.pairedOn === "boolean" ? { on: answer.on, pairedOn: answer.pairedOn } : null;
}

// Every view that shows the switch hears a change as soon as one of them learns it, so Settings, the dock, and Home agree at once. The views share
// one reader: it asks every few seconds while at least one view listens, and stops, forgetting what it knew, when the last one leaves.
const heard = new Set<(state: ArilSwitchState) => void>();
let latest: ArilSwitchState | null = null;
let reading: { timer: number | undefined; live: boolean } | null = null;
const publish = (state: ArilSwitchState) => {
  // An ask that learns nothing new tells nobody, so a view that follows the switch is not drawn again every few seconds.
  if (latest !== null && latest.on === state.on && latest.pairedOn === state.pairedOn) return;
  latest = state;
  for (const listener of [...heard]) listener(state);
};

function startReading() {
  const mine = { timer: undefined as number | undefined, live: true };
  reading = mine;
  const read = async () => {
    const next = switchOf(await request("aril_switch", {}));
    if (!mine.live) return;
    if (next) publish(next);
    mine.timer = window.setTimeout(() => { void read(); }, POLL_MS);
  };
  void read();
}

function stopReading() {
  if (reading) { reading.live = false; window.clearTimeout(reading.timer); }
  reading = null;
  latest = null;
}

/** Listens for the switch. The first listener starts the shared reader; a later one is told what is known at once. Answers how to stop listening. */
function listen(listener: (state: ArilSwitchState) => void): () => void {
  heard.add(listener);
  if (reading === null) startReading();
  else if (latest !== null) listener(latest);
  return () => {
    heard.delete(listener);
    if (heard.size === 0) stopReading();
  };
}

export type ArilSwitchControl = {
  availability: ArilControlAvailability;
  /** Null until the desktop has answered: nothing is drawn for a state that is not known. */
  state: ArilSwitchState | null;
  busy: boolean;
  failed: boolean;
  /** Whether this client may turn Aril On: the desktop always, a paired device only when the owner allowed it. A client may always turn it Off. */
  canTurnOn: boolean;
  setOn(next: boolean): Promise<boolean>;
  setPairedOn(next: boolean): Promise<boolean>;
};

/**
 * The switch. While `active`, it is asked every few seconds (once for all the views that listen); a view that passes false asks nothing and knows
 * nothing. The state is null until the desktop has answered, and it is never taken back to null by a failed ask, so a view that waits for it
 * (the dock and Home draw nothing of Aril before it is known) never shows something and then retracts it.
 */
export function useArilSwitch(active = true): ArilSwitchControl {
  const availability = useArilControlAvailability();
  const [state, setState] = useState<ArilSwitchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = reachable(availability);
  // A view that stops listening forgets what it knew, so it never opens on an old state.
  useEffect(() => {
    if (!ready || !active) return undefined;
    const stop = listen(setState);
    return () => { stop(); setState(null); };
  }, [ready, active]);
  const change = useCallback(async (operation: "aril_switch_set" | "aril_paired_on_set", payload: Json) => {
    setBusy(true);
    setFailed(false);
    try {
      const answer = await request(operation, payload);
      const after = switchOf(await request("aril_switch", {}));
      if (after) publish(after);
      const ok = answer?.ok === true;
      if (!ok) setFailed(true);
      return ok;
    } finally { setBusy(false); }
  }, []);
  const setOn = useCallback((next: boolean) => change("aril_switch_set", { on: next }), [change]);
  const setPairedOn = useCallback((next: boolean) => change("aril_paired_on_set", { allowed: next }), [change]);
  return { availability, state, busy, failed, canTurnOn: availability === "desktop" || (availability === "paired" && state?.pairedOn === true), setOn, setPairedOn };
}

const memoryOf = (value: unknown): OwnerMemory | null => {
  const memory = record(value);
  if (!memory || typeof memory.text !== "string" || !(memory.previous === null || typeof memory.previous === "string")) return null;
  const updatedBy = memory.updatedBy === "owner" || memory.updatedBy === "aril" ? memory.updatedBy : memory.updatedBy === null ? null : undefined;
  if (updatedBy === undefined || !(memory.updatedAt === null || typeof memory.updatedAt === "number")) return null;
  return { text: memory.text, previous: memory.previous, updatedAt: memory.updatedAt, updatedBy };
};

export type OwnerMemoryControl = {
  availability: ArilControlAvailability;
  /** Null until the desktop has answered. */
  memory: OwnerMemory | null;
  /** Only the desktop app edits the owner's memory; a paired device reads it. */
  editable: boolean;
  busy: boolean;
  /** Replaces the text whole. Answers whether the desktop kept it. */
  set(text: string): Promise<boolean>;
};

/** The owner's memory: read once when the view opens, and again after each change the desktop accepted. */
export function useOwnerMemory(): OwnerMemoryControl {
  const availability = useArilControlAvailability();
  const [memory, setMemory] = useState<OwnerMemory | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = reachable(availability);
  useEffect(() => {
    if (!ready) return undefined;
    let live = true;
    void request("owner_memory", {}).then((answer) => {
      const read = answer?.ok === true ? memoryOf(answer.memory) : null;
      if (live && read) setMemory(read);
    });
    return () => { live = false; };
  }, [ready]);
  const set = useCallback(async (text: string) => {
    setBusy(true);
    try {
      const answer = await request("owner_memory_set", { text });
      const kept = answer?.ok === true ? memoryOf(answer.memory) : null;
      if (kept) setMemory(kept);
      return kept !== null;
    } finally { setBusy(false); }
  }, []);
  return { availability, memory, editable: availability === "desktop", busy, set };
}

export type ThreadSpaceControl = {
  /** Null until the desktop has answered. */
  repositories: ThreadSpace[] | null;
  /** "Flush oldest at" in megabytes (0 is Never); null until the desktop has answered. */
  limit: number | null;
  /** The repository being flushed, if any. */
  flushing: string | null;
  /** Removes the oldest half of a thread's messages and answers what it removed, or why it did not: `busy` while Aril answers in that repository. */
  flush(repositoryId: string): Promise<{ flushed: ThreadFlushed } | { error: "busy" | "failed" }>;
  /** Sets "Flush oldest at". Answers whether the desktop kept it. */
  setLimit(megabytes: number): Promise<boolean>;
};

/** What each thread takes on disk, its flush, and the limit that flushes a thread by itself. Drawn only by the desktop app. */
export function useThreadSpace(): ThreadSpaceControl {
  const availability = useArilControlAvailability();
  const [repositories, setRepositories] = useState<ThreadSpace[] | null>(null);
  const [limit, setLimitState] = useState<number | null>(null);
  const [flushing, setFlushing] = useState<string | null>(null);
  // The sizes are read when the section opens, and again after each flush and each new limit, through `revision`.
  const [revision, setRevision] = useState(0);
  const desktop = availability === "desktop";
  useEffect(() => {
    if (!desktop) return undefined;
    let live = true;
    void request("thread_space", {}).then((answer) => {
      const list = answer?.ok === true && Array.isArray(answer.repositories) ? answer.repositories.map(record) : null;
      if (live && list && typeof answer?.limit === "number" && THREAD_LIMIT_MEGABYTES.includes(answer.limit)
        && list.every((entry) => entry && typeof entry.repositoryId === "string" && typeof entry.bytes === "number" && typeof entry.messages === "number")) {
        setRepositories((list as Json[]).map((entry) => ({ repositoryId: entry.repositoryId as string, bytes: entry.bytes as number, messages: entry.messages as number })));
        setLimitState(answer.limit);
      }
    });
    return () => { live = false; };
  }, [desktop, revision]);
  const flush = useCallback(async (repositoryId: string) => {
    setFlushing(repositoryId);
    try {
      const answer = await request("thread_flush", { repositoryId });
      setRevision((current) => current + 1);
      return answer?.ok === true && typeof answer.messages === "number" && typeof answer.conversations === "number" && typeof answer.images === "number" && typeof answer.freed === "number"
        ? { flushed: { messages: answer.messages, conversations: answer.conversations, images: answer.images, freed: answer.freed } } : { error: answer?.error === "busy" ? "busy" as const : "failed" as const };
    } finally { setFlushing(null); }
  }, []);
  // A new limit may flush a thread that is over it, so the sizes are read again a moment later as well.
  const setLimit = useCallback(async (megabytes: number) => {
    const answer = await request("thread_limit_set", { megabytes });
    const kept = answer?.ok === true && answer.limit === megabytes;
    if (kept) { setLimitState(megabytes); setRevision((current) => current + 1); }
    return kept;
  }, []);
  return { repositories, limit, flushing, flush, setLimit };
}
