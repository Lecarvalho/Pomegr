"use client";

import { useEffect, useRef, useState } from "react";
import { copyText } from "../../clipboard";

type CopyState = "idle" | "copied" | "error";

export function SessionIdChip({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copySessionId = async () => {
    try {
      await copyText(sessionId);
      setState("copied");
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setState("idle"), 2200);
    } catch {
      setState("error");
    }
  };

  const shortId = sessionId.length > 11 ? `${sessionId.slice(0, 5)}…${sessionId.slice(-5)}` : sessionId;
  const tone = state === "copied" ? " positive" : state === "error" ? " negative" : "";
  const title = state === "copied"
    ? "Session ID copied"
    : state === "error"
      ? "Retry copying session ID"
      : `Copy session ID ${sessionId}`;
  const announcement = state === "copied"
    ? "Session ID copied."
    : state === "error"
      ? "Session ID could not be copied. Try again."
      : "";

  return (
    <>
      <button className={`commandChip sessionIdChip${tone}`} onClick={() => void copySessionId()} title={title} type="button">{shortId}</button>
      <span className="srOnly" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </>
  );
}
