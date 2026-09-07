import type { RepositorySummary } from "../../../shared/monitor-contract";
import { relativeTime } from "../../dashboard-utils";

export function repositorySetupSummary(repository: RepositorySummary): { label: string; tone: "positive" | "warning" | "neutral" } {
  const providers = repository.providers;
  if (providers.some(({ pluginSetup }) => pluginSetup?.readiness === "loading")) return { label: "Checking setup", tone: "neutral" };
  if (providers.some(({ pluginSetup }) => pluginSetup?.canUpdate)) return { label: "Plugin update available", tone: "warning" };
  if (providers.some(({ sessionCount, pluginSetup }) => sessionCount > 0 && pluginSetup?.installation === "not_installed")) return { label: "Plugin not installed", tone: "warning" };
  if (providers.some(({ pluginSetup }) => pluginSetup?.enabled === false)) return { label: "Plugin disabled", tone: "warning" };
  if (repository.reporting?.status === "invalid") return { label: "Reporting invalid", tone: "warning" };
  // The normalized API calls an absent reporting policy "missing".
  if (repository.reporting?.status === "missing") return { label: "Reporting not configured", tone: "neutral" };
  if (providers.some(({ pluginSetup }) => !pluginSetup || pluginSetup.readiness === "unavailable" || pluginSetup.installation === "unknown") || !repository.reporting || repository.reporting.status === "unknown") return { label: "Setup unverified", tone: "neutral" };
  return { label: "Ready", tone: "positive" };
}

export function repositoryLastActivity(repository: RepositorySummary): string {
  return repository.updatedAt ? relativeTime(repository.updatedAt) : "—";
}
