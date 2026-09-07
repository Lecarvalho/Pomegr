import type { RepositoryProviderInventory } from "../../../shared/monitor-contract";
import type { RepositoryPluginAction, RepositoryPluginActionStatus, RepositoryPluginSetup, RepositoryReportingSetup } from "../../../shared/repository-plugin-contract";

export function failureMessage(kind: RepositoryProviderInventory["failureKind"]) {
  if (kind === "executable_unavailable") return "Claude Code executable unavailable";
  if (kind === "timed_out") return "The diagnostic timed out";
  if (kind === "invalid_output") return "Claude Code returned an unsupported diagnostic format";
  return "The local diagnostic could not run";
}

export function versionLabel(version: string | null) {
  return version ? (version.startsWith("v") ? version : `v${version}`) : null;
}

export function inventoryState(provider: RepositoryProviderInventory, capturing = false) {
  if (capturing || provider.status === "capturing") return { label: "Capturing", tone: "warning" };
  if (provider.status === "failed") return { label: "Failed", tone: "negative" };
  if (provider.status === "unavailable") return { label: "Unavailable", tone: "neutral" };
  return provider.currentRevision ? { label: `${provider.currentRevision.id} saved`, tone: "info" } : { label: "Not captured", tone: "neutral" };
}

export function pluginStatus(setup: RepositoryPluginSetup | undefined) {
  if (setup?.readiness === "loading") return { label: "Checking plugin setup", tone: "checking" };
  if (!setup || setup.readiness === "unavailable" || setup.installation === "unknown") return { label: "Unable to verify", tone: "unknown" };
  if (setup.installation === "not_installed") return { label: "Not installed", tone: "neutral" };
  if (setup.enabled === true) return { label: "Enabled", tone: "ready" };
  if (setup.enabled === false) return { label: "Disabled", tone: "warning" };
  return { label: "Status unknown", tone: "unknown" };
}

export function pluginDetail(setup: RepositoryPluginSetup | undefined) {
  if (setup?.readiness === "loading") return "Checking local installation and update information.";
  if (!setup || setup.readiness === "unavailable" || setup.installation === "unknown") return "Local installation records could not be verified. Recheck to refresh the available information.";
  if (setup.installation === "not_installed") return "Enable agent-reported signals and progress for this provider.";
  const scope = setup.scope ? `${setup.scope[0].toUpperCase()}${setup.scope.slice(1)} installation` : "Local installation";
  if (setup.update.status === "available") return `${scope} · Update ${versionLabel(setup.update.version) || "available"}`;
  if (setup.update.status === "pinned") return `${scope} · Version is pinned`;
  if (setup.update.status === "unavailable") return `${scope} · Update check unavailable`;
  if (setup.update.status === "unknown") return `${scope} · Update status unknown`;
  return `${scope} · Up to date`;
}

export function reportingState(reporting: RepositoryReportingSetup | undefined) {
  if (!reporting || reporting.status === "unknown") return { label: "Unavailable", detail: "Reporting setup could not be verified.", tone: "unknown" };
  if (reporting.status === "configured") return { label: "Configured", detail: reporting.version === null ? "Shared repository reporting policy" : `Shared repository policy · Version ${reporting.version}`, tone: "ready" };
  if (reporting.status === "invalid") return { label: "Invalid", detail: "Review the repository reporting policy with your coding agent.", tone: "warning" };
  return { label: "Not configured", detail: "Choose what agents report · Shared by Claude Code and Codex", tone: "neutral" };
}

export function pluginActionMessage(provider: RepositoryProviderInventory, action: RepositoryPluginAction, status: RepositoryPluginActionStatus) {
  if (status === "busy") return "A plugin action is already running.";
  if (status === "cancelled") return "No plugin changes were made.";
  if (status === "unavailable") return "This plugin action is unavailable in the current Pomegr desktop version.";
  if (status === "timed_out") return "The plugin action timed out. Recheck the local setup before trying again.";
  if (status === "failed") return "The plugin action could not finish. Recheck the local setup before trying again.";
  if (action === "recheck") return `${provider.source} plugin setup checked.`;
  const followUp = provider.provider === "codex"
    ? " Restart Codex, review hook trust, then start a new session."
    : " Reload Claude Code before starting a new session.";
  return `${action === "update" ? "Plugin update" : "Plugin installation"} completed. Pomegr refreshed the local setup.${followUp}`;
}

export type ProviderFeedback = { key: string; message: string; tone: "pending" | "success" | "neutral" | "error" };
