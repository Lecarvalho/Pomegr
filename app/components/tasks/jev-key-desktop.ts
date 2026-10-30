"use client";

import { useCallback, useEffect, useState } from "react";

// The Jev key of Aril's effort routing lives in desktop main. This is the renderer's whole view of it: whether it is set, a way to set it, and a
// way to remove it. No answer ever holds the key, and a paired device has no bridge, so it can neither set nor see the key.

export type JevKeyState = "set" | "unset" | "unavailable";
export type JevKeyControl = { state: JevKeyState | null; save(key: string): Promise<boolean>; remove(): Promise<boolean> };

/** One printable ASCII token: the same rule as desktop main's. */
export const JEV_KEY_PATTERN = /^[!-~]{8,512}$/u;

type Bridge = { agentChatJev(operation: "status" | "set" | "remove", payload?: { key: string }): Promise<unknown> };

const bridge = (): Bridge | undefined => {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as Window & { pomegrDesktop?: Partial<Bridge> }).pomegrDesktop;
  return typeof candidate?.agentChatJev === "function" ? candidate as Bridge : undefined;
};

const stateOf = (answer: unknown): JevKeyState | null => {
  const value = answer as { ok?: unknown; state?: unknown } | null;
  return value?.ok === true && (value.state === "set" || value.state === "unset" || value.state === "unavailable") ? value.state : null;
};

/** The key's control in the desktop app, or undefined where there is no bridge: the section is then not drawn at all. */
export function useJevKey(enabled: boolean): JevKeyControl | undefined {
  const desktop = enabled ? bridge() : undefined;
  const [state, setState] = useState<JevKeyState | null>(null);
  useEffect(() => {
    let current = true;
    if (desktop) void desktop.agentChatJev("status").then((answer) => { if (current) setState(stateOf(answer)); }, () => {});
    return () => { current = false; };
  }, [desktop]);
  const run = useCallback(async (operation: "set" | "remove", payload?: { key: string }) => {
    try {
      const next = stateOf(await desktop?.agentChatJev(operation, payload));
      if (next === null) return false;
      setState(next);
      return true;
    } catch { return false; }
  }, [desktop]);
  const save = useCallback((key: string) => run("set", { key }), [run]);
  const remove = useCallback(() => run("remove"), [run]);
  return desktop ? { state, save, remove } : undefined;
}
