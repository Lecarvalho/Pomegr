export const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;

export const repositoryTabs = [
  ["overview", "Overview"],
  ["plugin", "Plugin"],
  ["inventory", "Context inventory"],
  ["reporting", "Reporting"],
  ["git", "Git"],
] as const;

export type RepositoryTab = typeof repositoryTabs[number][0];
export type RepositorySearchParams = { tab?: string | string[]; provider?: string | string[]; revision?: string | string[] };

export function repositoryRouteId(value: unknown) {
  return typeof value === "string" && REPOSITORY_ID_PATTERN.test(value) ? value : undefined;
}

export function repositoryTab(value: unknown): RepositoryTab | undefined {
  if (value === "setup") return "plugin";
  return repositoryTabs.find(([id]) => id === value)?.[0];
}

export function repositoryRouteOptions({ tab, provider, revision }: RepositorySearchParams): {
  initialTab: RepositoryTab;
  initialProvider: "claude" | "codex" | undefined;
  initialRevisionId: string | undefined;
} {
  return {
    initialTab: repositoryTab(tab) ?? "overview",
    initialProvider: provider === "claude" || provider === "codex" ? provider : undefined,
    initialRevisionId: typeof revision === "string" && /^ctx-\d{3,9}$/u.test(revision) ? revision : undefined,
  };
}
