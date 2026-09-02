import type { UsageLimits } from "../../shared/monitor-contract";
import { usageLimitFailureKind } from "../usage-limit-presentation";
import { ExternalLink } from "./ExternalLink";

export function CodexUsageHelp({ usageLimits }: { usageLimits: UsageLimits }) {
  const failureKind = usageLimitFailureKind(usageLimits);
  const noWindows = !usageLimits.available && Boolean(usageLimits.fetchedAt);
  if (!failureKind && !noWindows) return null;

  return <div className="usageConnectionControls">
    <details className="usageConnectionHelp" open key={failureKind}>
      <summary>Usage connection help</summary>
      {failureKind === "runtime_unavailable" ? <>
        <p>On the computer running Pomegr, install or update the native Codex CLI, then run <code>codex login</code> and sign in with ChatGPT.</p>
        <p>Fully quit and reopen Pomegr after installing or updating the CLI. Codex desktop session history alone does not provide account usage.</p>
      </> : failureKind === "rate_limited" ? <p>Wait for the retry countdown. Pomegr respects the provider’s cooldown; signing in again does not shorten it.</p> : <>
        <p>On the computer running Pomegr, check <code>codex login status</code>. If signed out or using an API key, run <code>codex login</code> to sign in with ChatGPT.</p>
        <p>If already signed in with ChatGPT, check your internet connection. Pomegr retries automatically.</p>
      </>}
      <p><ExternalLink href="https://github.com/Lecarvalho/pomegr/blob/main/docs/CONFIGURATION.md#codex">Setup guide</ExternalLink></p>
    </details>
  </div>;
}
