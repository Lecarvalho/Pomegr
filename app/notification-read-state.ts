"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pomegr:notification-read:v1";
const VERSION = 1;
const ID = /^[a-f0-9]{32}$/u;
const MAX_MARKERS = 400;
const MAX_BYTES = 32 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_LEAD_MS = 5 * 60_000;
const EMPTY = new Set<string>();

type MarkerStorage = Pick<Storage, "getItem" | "setItem">;

function validMarker(value: unknown, now: number): value is [string, number] {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === "string" && ID.test(value[0])
    && Number.isSafeInteger(value[1]) && value[1] >= 0 && value[1] <= now + MAX_CLOCK_LEAD_MS;
}

/** Browser-local read state. Origin storage isolates local clients; random occurrence
 * identities isolate monitor/profile generations without exposing source scope. */
export class NotificationReadStore {
  private entries = new Map<string, number>();
  private state: ReadonlySet<string> = EMPTY;
  private listeners = new Set<() => void>();
  private loaded = false;
  private writable = true;
  private storage: MarkerStorage | null | undefined;
  private now: () => number;

  constructor(options: { storage?: MarkerStorage | null; now?: () => number } = {}) {
    this.storage = options.storage;
    this.now = options.now || Date.now;
  }

  getSnapshot = () => this.state;
  getServerSnapshot = () => EMPTY;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.load();
    return () => { this.listeners.delete(listener); };
  };

  private publish() {
    this.state = new Set(this.entries.keys());
    for (const listener of this.listeners) listener();
  }

  private resolveStorage() {
    if (this.storage !== undefined) return this.storage;
    try { this.storage = typeof window === "undefined" ? null : window.localStorage; }
    catch { this.storage = null; }
    return this.storage;
  }

  private prune(now: number) {
    for (const [id, at] of this.entries) if (now - at > RETENTION_MS) this.entries.delete(id);
    if (this.entries.size <= MAX_MARKERS) return;
    const ordered = [...this.entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    this.entries = new Map(ordered.slice(0, MAX_MARKERS));
  }

  private write() {
    if (!this.writable) return;
    const storage = this.resolveStorage();
    if (!storage) { this.writable = false; return; }
    const entries = [...this.entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const value = JSON.stringify({ version: VERSION, entries });
    if (value.length > MAX_BYTES) { this.writable = false; return; }
    try { storage.setItem(STORAGE_KEY, value); } catch { this.writable = false; }
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const storage = this.resolveStorage();
    if (!storage) { this.writable = false; return; }
    let text: string | null;
    try { text = storage.getItem(STORAGE_KEY); } catch { this.writable = false; return; }
    if (text === null) return;
    if (text.length > MAX_BYTES) { this.writable = false; return; }
    let source: unknown;
    try { source = JSON.parse(text); } catch { this.writable = false; return; }
    const record = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : null;
    const now = this.now();
    if (!record || record.version !== VERSION || Object.keys(record).length !== 2
      || !Array.isArray(record.entries) || record.entries.length > MAX_MARKERS
      || record.entries.some((entry) => !validMarker(entry, now))
      || new Set(record.entries.map((entry: [string, number]) => entry[0])).size !== record.entries.length) {
      this.writable = false;
      return;
    }
    this.entries = new Map(record.entries as [string, number][]);
    const originalCount = this.entries.size;
    this.prune(now);
    this.publish();
    if (this.entries.size !== originalCount) this.write();
  }

  markRead(ids: readonly string[]) {
    this.load();
    const now = this.now();
    const before = this.entries.size;
    this.prune(now);
    let changed = this.entries.size !== before;
    for (const id of ids) {
      if (typeof id !== "string" || !ID.test(id) || this.entries.has(id)) continue;
      this.entries.set(id, now);
      changed = true;
    }
    this.prune(now);
    if (changed) { this.publish(); this.write(); }
  }
}

let sharedStore: NotificationReadStore | null = null;
export function getNotificationReadStore() {
  if (!sharedStore) sharedStore = new NotificationReadStore();
  return sharedStore;
}
export function useNotificationReadState() {
  const store = getNotificationReadStore();
  return { read: useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot), markRead: store.markRead.bind(store) };
}
