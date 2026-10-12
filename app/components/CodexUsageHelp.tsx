"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { UsageLimits } from "../../shared/monitor-contract";
import { usageLimitFailureKind } from "../usage-limit-presentation";
import { getUsageLimitsStore } from "../usage-limits-client";
import { ExternalLink } from "./ExternalLink";

type SignInStatus = "completed" | "cancelled" | "failed" | "unavailable" | "busy" | "timed_out";
type CodexDesktopBridge = { startCodexSignIn?: () => Promise<{ status: SignInStatus }> };

const SIGN_IN_MESSAGES: Record<SignInStatus, string> = {
  completed: "Codex sign-in completed. Checking usage…",
  cancelled: "Sign-in cancelled. You can reconnect whenever you’re ready.",
  failed: "Codex could not complete sign-in. Try again, or see the setup guide.",
  unavailable: "Codex could not be found. Install the native Codex CLI on this computer, then try again.",
  busy: "A Codex sign-in is already open. Finish it in your browser.",
  timed_out: "Sign-in timed out. Try again, or see the setup guide.",
};

const subscribeDesktop = () => () => {};
const desktopSnapshot = () => (window as Window & { pomegrDesktop?: CodexDesktopBridge }).pomegrDesktop || null;
const serverDesktopSnapshot = () => null;

export function CodexUsageHelp({ usageLimits }: { usageLimits: UsageLimits }) {
  const bridge = useSyncExternalStore(subscribeDesktop, desktopSnapshot, serverDesktopSnapshot);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const failureKind = usageLimitFailureKind(usageLimits);
  const noWindows = !usageLimits.available && Boolean(usageLimits.fetchedAt);
  const needsSignIn = failureKind === "authentication_required";
  const canOfferReconnect = failureKind !== "rate_limited" && (needsSignIn || failureKind === "unavailable" || failureKind === "runtime_unavailable" || noWindows);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function reconnect() {
    if (inFlight.current || !bridge?.startCodexSignIn) return;
    inFlight.current = true;
    setPending(true);
    setMessage("Opening Codex sign-in. Continue in the desktop dialog and your browser.");
    try {
      const result = await bridge.startCodexSignIn();
      if (result?.status === "completed") {
        if (!mounted.current) return;
        setMessage(SIGN_IN_MESSAGES.completed);
        try {
          const store = getUsageLimitsStore();
          const refreshed = await store.refreshAfterSignIn();
          if (!mounted.current) return;
          if (!refreshed) {
            setMessage("Pomegr could not refresh usage. It will retry automatically.");
          } else {
            const codexUsage = store.getSnapshot().providers.find((provider) => provider.provider === "codex")?.usageLimits;
            const refreshedFailure = codexUsage ? usageLimitFailureKind(codexUsage) : null;
            if (refreshedFailure === "runtime_unavailable") {
              setMessage("Codex CLI could not be verified. Pomegr retries automatically.");
            } else if (!codexUsage?.available || refreshedFailure || !codexUsage.limits.length) {
              setMessage("Usage is still unavailable. Pomegr retries automatically.");
            } else {
              setMessage("Usage refreshed.");
            }
          }
        } catch {
          if (mounted.current) setMessage("Pomegr could not refresh usage. It will retry automatically.");
        }
        return;
      }
      if (!mounted.current) return;
      setMessage(SIGN_IN_MESSAGES[result?.status] || SIGN_IN_MESSAGES.failed);
    } catch {
      if (mounted.current) setMessage(SIGN_IN_MESSAGES.failed);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }

  if (!failureKind && !noWindows) return null;

  const canReconnect = canOfferReconnect && Boolean(bridge?.startCodexSignIn);
  return <div className="usageConnectionControls">
    <details className="usageConnectionHelp" open key={failureKind}>
      <summary>Usage connection help</summary>
      {failureKind === "runtime_unavailable" ? <>
        <p>On the computer running Pomegr, install or update the native Codex CLI, then run <code>codex login</code> and sign in with ChatGPT.</p>
        <p>Fully quit and reopen Pomegr after installing or updating the CLI. Codex desktop session history alone does not provide account usage.</p>
      </> : failureKind === "rate_limited" ? <p>Wait for the retry countdown. Pomegr respects the provider’s cooldown; signing in again does not shorten it.</p> : needsSignIn || failureKind === "unavailable" || noWindows ? <>
        {canReconnect
          ? <p>Reconnect Codex to sign in again.</p>
          : <p>On the computer running Pomegr, check <code>codex login status</code>. If signed out or using an API key, run <code>codex login</code> to sign in with ChatGPT.</p>}
        <p>If already signed in with ChatGPT, check your internet connection. Pomegr retries automatically.</p>
      </> : <>
        <p>On the computer running Pomegr, check <code>codex login status</code>. If signed out or using an API key, run <code>codex login</code> to sign in with ChatGPT.</p>
        <p>If already signed in with ChatGPT, check your internet connection. Pomegr retries automatically.</p>
      </>}
      <div className="claudeUsageActions">
        {canReconnect && <button className="commandSecondaryAction" type="button" disabled={pending} onClick={() => void reconnect()}>{pending ? "Waiting for sign-in…" : "Reconnect Codex"}</button>}
        <ExternalLink href="https://pomegr.com/docs/concepts/usage-limits#if-a-window-is-missing">Setup guide</ExternalLink>
      </div>
      {message && <p role="status" aria-live="polite">{message}</p>}
    </details>
  </div>;
}
