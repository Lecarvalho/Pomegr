"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ArilControlOperationName, ArilSwitchState, OwnerMemoryEntry, ThreadFlushed, ThreadSpace } from "../shared/agent-chat-contract";
import { useClientAccess } from "./hooks/ClientAccessContext";

// Client of Aril's own controls: the On/Off switch, the owner's memory, and the space each thread takes. The desktop app owns them: this
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

// Every view that shows the switch hears a change as soon as one of them learns it, so Settings and the panel header agree at once.
const heard = new Set<(state: ArilSwitchState) => void>();
const publish = (state: ArilSwitchState) => { for (const listener of [...heard]) listener(state); };

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

/** The switch. While `active`, it is asked every few seconds; a view that is closed passes false and asks nothing. */
export function useArilSwitch(active = true): ArilSwitchControl {
  const availability = useArilControlAvailability();
  const [state, setState] = useState<ArilSwitchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = reachable(availability);
  // Only a view that is open hears the switch and asks for it. One that closes forgets what it knew, so it never opens on an old state.
  useEffect(() => {
    if (!ready || !active) return undefined;
    let live = true;
    let timer: number | undefined;
    heard.add(setState);
    const read = async () => {
      const next = switchOf(await request("aril_switch", {}));
      if (!live) return;
      if (next) publish(next);
      timer = window.setTimeout(() => { void read(); }, POLL_MS);
    };
    void read();
    return () => { live = false; heard.delete(setState); window.clearTimeout(timer); setState(null); };
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

const entryOf = (value: unknown): OwnerMemoryEntry | null => {
  const entry = record(value);
  return entry && typeof entry.id === "number" && typeof entry.text === "string" && typeof entry.createdAt === "number" && typeof entry.updatedAt === "number"
    ? { id: entry.id, text: entry.text, createdAt: entry.createdAt, updatedAt: entry.updatedAt } : null;
};

export type OwnerMemoryControl = {
  availability: ArilControlAvailability;
  /** Oldest first; null until the desktop has answered. */
  entries: OwnerMemoryEntry[] | null;
  /** Only the desktop app edits the owner's memory; a paired device reads it. */
  editable: boolean;
  busy: boolean;
  add(text: string): Promise<boolean>;
  update(id: number, text: string): Promise<boolean>;
  remove(id: number): Promise<boolean>;
};

/** The owner's memory: read once when the view opens, and again after each change the desktop accepted. */
export function useOwnerMemory(): OwnerMemoryControl {
  const availability = useArilControlAvailability();
  const [entries, setEntries] = useState<OwnerMemoryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Each change the desktop accepted asks for the lines again, through `revision`.
  const [revision, setRevision] = useState(0);
  const ready = reachable(availability);
  useEffect(() => {
    if (!ready) return undefined;
    let live = true;
    void request("owner_memory", {}).then((answer) => {
      const list = answer?.ok === true && Array.isArray(answer.entries) ? answer.entries.map(entryOf) : null;
      if (live && list && list.every((entry) => entry !== null)) setEntries(list as OwnerMemoryEntry[]);
    });
    return () => { live = false; };
  }, [ready, revision]);
  const change = useCallback(async (operation: ArilControlOperationName, payload: Json) => {
    setBusy(true);
    try {
      const ok = (await request(operation, payload))?.ok === true;
      if (ok) setRevision((current) => current + 1);
      return ok;
    } finally { setBusy(false); }
  }, []);
  return {
    availability, entries, editable: availability === "desktop", busy,
    add: (text) => change("owner_memory_add", { text }),
    update: (id, text) => change("owner_memory_update", { id, text }),
    remove: (id) => change("owner_memory_remove", { id }),
  };
}

export type ThreadSpaceControl = {
  /** Null until the desktop has answered. */
  repositories: ThreadSpace[] | null;
  /** The repository being flushed, if any. */
  flushing: string | null;
  /** Removes the oldest half of a thread's messages and answers what it removed, or why it did not: `busy` while Aril answers in that repository. */
  flush(repositoryId: string): Promise<{ flushed: ThreadFlushed } | { error: "busy" | "failed" }>;
};

/** What each thread takes on disk, and its flush. Drawn only by the desktop app. */
export function useThreadSpace(): ThreadSpaceControl {
  const availability = useArilControlAvailability();
  const [repositories, setRepositories] = useState<ThreadSpace[] | null>(null);
  const [flushing, setFlushing] = useState<string | null>(null);
  // The sizes are read when the section opens, and again after each flush, through `revision`.
  const [revision, setRevision] = useState(0);
  const desktop = availability === "desktop";
  useEffect(() => {
    if (!desktop) return undefined;
    let live = true;
    void request("thread_space", {}).then((answer) => {
      const list = answer?.ok === true && Array.isArray(answer.repositories) ? answer.repositories.map(record) : null;
      if (live && list && list.every((entry) => entry && typeof entry.repositoryId === "string" && typeof entry.bytes === "number" && typeof entry.messages === "number")) {
        setRepositories((list as Json[]).map((entry) => ({ repositoryId: entry.repositoryId as string, bytes: entry.bytes as number, messages: entry.messages as number })));
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
  return { repositories, flushing, flush };
}
