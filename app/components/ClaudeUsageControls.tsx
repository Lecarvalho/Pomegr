"use client";

import { useEffect, useRef, useState } from "react";
import type { UsageLimits } from "../../shared/monitor-contract";
import { usageLimitFailureKind } from "../usage-limit-presentation";
import { ExternalLink } from "./ExternalLink";

type IntegrationStatus = "enabled" | "disabled" | "unavailable";
type SignInStatus = "completed" | "cancelled" | "failed" | "unavailable" | "busy" | "timed_out";
type IntegrationResult = IntegrationStatus | "cancelled" | "failed" | "busy";
type ClaudeDesktopBridge = {
  startClaudeSignIn?: () => Promise<{ status: SignInStatus }>;
  getClaudeUsageIntegration?: () => Promise<{ status: IntegrationStatus }>;
  enableClaudeUsageIntegration?: () => Promise<{ status: IntegrationResult }>;
};

const SIGN_IN_MESSAGES: Record<SignInStatus, string> = {
  completed: "Claude Code sign-in completed. Pomegr will retry the usage check automatically.",
  cancelled: "Sign-in cancelled. You can reconnect whenever you’re ready.",
  failed: "Claude Code could not complete sign-in. Try again, or see the setup guide.",
  unavailable: "Claude Code could not be found. Install the native Claude Code app on this computer, then try again.",
  busy: "A Claude Code sign-in is already open. Finish it in your browser.",
  timed_out: "Sign-in timed out. Try again, or see the setup guide.",
};

const SETUP_MESSAGES: Record<IntegrationResult, string> = {
  enabled: "Local usage feed enabled. Figures appear after Claude Code reports usage in a supported session.",
  disabled: "Local usage feed is not enabled.",
  cancelled: "Setup cancelled. Your Claude Code settings were not changed.",
  failed: "The local usage feed could not be enabled. Your existing status line has been preserved. Try again after any settings edits finish.",
  unavailable: "Local usage setup is unavailable in this installation. See the setup instructions below.",
  busy: "Local usage setup is already in progress.",
};

/** Desktop actions have no corresponding HTTP endpoint in the LAN dashboard. */
export function ClaudeUsageControls({ usageLimits, showObservationNote = true }: { usageLimits: UsageLimits; showObservationNote?: boolean }) {
  const [bridge, setBridge] = useState<ClaudeDesktopBridge | null>(null);
  const [integration, setIntegration] = useState<IntegrationStatus>("unavailable");
  const [pending, setPending] = useState<"setup" | "signin" | null>(null);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const failureKind = usageLimitFailureKind(usageLimits);
  const authenticationFailed = failureKind === "authentication_required";

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const desktop = (window as Window & { pomegrDesktop?: ClaudeDesktopBridge }).pomegrDesktop;
    const read = async () => {
      let status: IntegrationStatus = "unavailable";
      try {
        const result = await desktop?.getClaudeUsageIntegration?.();
        if (result?.status === "enabled" || result?.status === "disabled") status = result.status;
      } catch { /* Recovery must not expose native error text. */ }
      if (active) {
        setBridge(desktop || null);
        setIntegration(status);
      }
    };
    void read();
    window.addEventListener("focus", read);
    return () => {
      active = false;
      mounted.current = false;
      window.removeEventListener("focus", read);
    };
  }, []);

  async function run(action: "setup" | "signin") {
    if (inFlight.current) return;
    const operation = action === "setup" ? bridge?.enableClaudeUsageIntegration : bridge?.startClaudeSignIn;
    if (!operation) return;
    inFlight.current = true;
    setPending(action);
    setMessage(action === "setup" ? "Confirm local usage setup in the desktop dialog." : "Opening Claude Code sign-in. Continue in the desktop dialog and your browser.");
    try {
      const result = await operation();
      if (!mounted.current) return;
      if (action === "setup") {
        const status = result?.status as IntegrationResult;
        if (status === "enabled") setIntegration("enabled");
        setMessage(SETUP_MESSAGES[status] || SETUP_MESSAGES.failed);
      } else {
        setMessage(SIGN_IN_MESSAGES[result?.status as SignInStatus] || SIGN_IN_MESSAGES.failed);
      }
    } catch {
      if (mounted.current) setMessage(action === "setup" ? SETUP_MESSAGES.failed : SIGN_IN_MESSAGES.failed);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const canSetUp = !usageLimits.available && Boolean(bridge?.enableClaudeUsageIntegration) && integration === "disabled";
  const canSignIn = Boolean(bridge?.startClaudeSignIn);
  const local = usageLimits.origin === "local_observation";
  const needsSignIn = authenticationFailed || usageLimits.error === "Claude usage credentials are unavailable.";
  const needsConnectionHelp = Boolean(failureKind);

  if (!needsConnectionHelp) {
    return local && showObservationNote ? <div className="usageConnectionControls"><p>Usage reported by Claude Code. Figures may lag activity elsewhere on your account.</p></div> : null;
  }

  return <div className="usageConnectionControls">
    {local && showObservationNote && <p>Usage reported by Claude Code. Figures may lag activity elsewhere on your account.</p>}
    <details className="usageConnectionHelp" open key={failureKind}>
      <summary>Usage connection help</summary>
      {needsSignIn
        ? canSignIn
          ? <p>Reconnect Claude Code to sign in again.</p>
          : <p>On the computer running Pomegr, run <code>claude auth login --claudeai</code> and complete the browser sign-in. The Reconnect button is available in Pomegr Desktop.</p>
        : failureKind === "rate_limited"
          ? <p>Wait for the retry countdown. Pomegr respects the provider’s cooldown; signing in again does not shorten it.</p>
          : <p>Check your internet connection and that Claude Code is signed in on the computer running Pomegr. Pomegr retries automatically.</p>}
      {canSetUp && <p>Enable local usage to keep readings available when account checks fail. Supports Claude Pro and Max.</p>}
      {(canSetUp || (canSignIn && needsSignIn)) && <div className="claudeUsageActions">
        {canSetUp && <button className="commandSecondaryAction" type="button" disabled={pending !== null} onClick={() => void run("setup")}>{pending === "setup" ? "Enabling local usage…" : "Enable local usage"}</button>}
        {canSignIn && needsSignIn && <button className="commandSecondaryAction" type="button" disabled={pending !== null} onClick={() => void run("signin")}>{pending === "signin" ? "Waiting for sign-in…" : "Reconnect Claude Code"}</button>}
      </div>}
      {message && <p role="status" aria-live="polite">{message}</p>}
      <p><ExternalLink href="https://github.com/Lecarvalho/pomegr/blob/main/docs/CONFIGURATION.md#claude-local-usage-feed">Setup guide</ExternalLink></p>
    </details>
  </div>;
}
