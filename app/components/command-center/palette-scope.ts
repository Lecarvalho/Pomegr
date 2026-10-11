"use client";

import { useSyncExternalStore } from "react";

export type PaletteScopeItem = { id: string; label: string; detail: string; terms: string };

export type PaletteScope = {
  label: string;
  placeholder: string;
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

export function matchPaletteScopeItems(items: readonly PaletteScopeItem[], query: string, limit: number): PaletteScopeItem[] {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matched: PaletteScopeItem[] = [];
  for (const item of items) {
    if (matched.length >= limit) break;
    if (words.every((word) => item.terms.includes(word))) matched.push(item);
  }
  return matched;
}
