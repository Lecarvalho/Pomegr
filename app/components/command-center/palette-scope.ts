"use client";

import { useSyncExternalStore } from "react";

/** One thing the page in view offers to the Search bar. `terms` is the lowercased text a query is matched against. */
export type PaletteScopeItem = { id: string; label: string; detail: string; terms: string };

/**
 * What the page in view adds to the Search bar: its own items, listed before the destinations, and what choosing one
 * does. The items stay in this module's memory with the page that registered them; nothing is stored or put in a URL.
 */
export type PaletteScope = {
  /** The Search bar's visible label while this page is in view, such as "Search tasks". */
  label: string;
  placeholder: string;
  /** Shown when a query matches nothing. */
  emptyLine: string;
  items: readonly PaletteScopeItem[];
  onSelect(id: string): void;
};

let current: PaletteScope | null = null;
const listeners = new Set<() => void>();

function publish(next: PaletteScope | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** Registers the page's scope; the returned function withdraws it unless another scope has replaced it since. */
export function setPaletteScope(scope: PaletteScope): () => void {
  publish(scope);
  return () => { if (current === scope) publish(null); };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const getSnapshot = () => current;
const getServerSnapshot = () => null;

export function usePaletteScope(): PaletteScope | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Items whose terms hold every word of the query, in their given order; an empty query matches all. */
export function matchPaletteScopeItems(items: readonly PaletteScopeItem[], query: string, limit: number): PaletteScopeItem[] {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matched: PaletteScopeItem[] = [];
  for (const item of items) {
    if (matched.length >= limit) break;
    if (words.every((word) => item.terms.includes(word))) matched.push(item);
  }
  return matched;
}
