"use client";

import { useEffect, useRef, useState } from "react";
import { useClientAccess } from "../hooks/ClientAccessContext";

type CopyState = "idle" | "loading" | "copied" | "error";

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.insetInlineStart = "-10000px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

export function CopyTranscriptButton({ sessionId, agentId, agentLabel }: {
  sessionId: string;
  agentId: string;
  agentLabel: string;
}) {
  const { canCopyTranscriptPath } = useClientAccess();
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copyTranscriptPath = async () => {
    if (state === "loading") return;
    setState("loading");
    try {
      const params = new URLSearchParams({ sessionId, agentId });
      const response = await fetch(`/api/transcript-path?${params}`, { cache: "no-store" });
      const body = await response.json() as { path?: unknown };
      if (!response.ok || typeof body.path !== "string" || body.path.length === 0 || body.path.length > 32_768) {
        throw new Error("Transcript path unavailable");
      }
      await copyText(body.path);
      setState("copied");
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setState("idle"), 2200);
    } catch {
      setState("error");
    }
  };

  const title = state === "loading"
    ? "Copying transcript path…"
    : state === "copied"
      ? "Transcript path copied"
      : state === "error"
        ? "Retry copying transcript path"
        : "Copy transcript path";
  const announcement = state === "copied"
    ? `Transcript path for ${agentLabel} copied.`
    : state === "error"
      ? `Transcript path for ${agentLabel} could not be copied. Try again.`
      : "";

  if (!canCopyTranscriptPath) return null;

  return (
    <>
      <button
        aria-label={`${title} for ${agentLabel}`}
        className={`copyTranscriptButton ${state}`}
        disabled={state === "loading"}
        onClick={() => void copyTranscriptPath()}
        title={title}
        type="button"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          {state === "copied"
            ? <path d="m3.5 8.2 2.7 2.7 6.3-6.3" />
            : <><rect x="5.5" y="2.5" width="7.5" height="9" /><path d="M10.5 13.5h-7.5v-9" /></>}
        </svg>
      </button>
      <span className="copyTranscriptAnnouncement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </>
  );
}
