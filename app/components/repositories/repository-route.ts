export const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;

// Order matches the design contract (F19): Overview, Files, Git, Plugin, Context inventory, Reporting.
export const repositoryTabs = [
  ["overview", "Overview"],
  ["files", "Files"],
  ["git", "Git"],
  ["plugin", "Plugin"],
  ["inventory", "Context inventory"],
  ["reporting", "Reporting"],
] as const;

export type RepositoryTab = typeof repositoryTabs[number][0];
export type RepositorySearchParams = { tab?: string | string[]; provider?: string | string[]; revision?: string | string[]; path?: string | string[] };

/** Upper bound shared with shared/repository-files-contract.ts's MAX_REPOSITORY_PATH_LENGTH,
 * duplicated here (a plain literal) so this client route module never imports the file-history
 * contract just for one constant. Both slices are the same shape by convention (F17-22 contract). */
const MAX_ROUTE_FILE_PATH_LENGTH = 512;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function repositoryRouteId(value: unknown) {
  return typeof value === "string" && REPOSITORY_ID_PATTERN.test(value) ? value : undefined;
}

export function repositoryTab(value: unknown): RepositoryTab | undefined {
  if (value === "setup") return "plugin";
  return repositoryTabs.find(([id]) => id === value)?.[0];
}

/** Shared by the repository page and the session Repository tab: a bounded repository-relative
 * path safe to carry in a URL query and hand to useFileHistory. Rejects anything that could read
 * as absolute, a Windows path, or a traversal segment; the monitor independently revalidates the
 * value server-side (see shared/repository-files-contract.ts, monitor/repository-snapshot.mjs). */
export function repositoryFilePath(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ROUTE_FILE_PATH_LENGTH) return undefined;
  if (raw.startsWith("/") || raw.includes("\\")) return undefined;
  if (CONTROL_CHARACTER_PATTERN.test(raw)) return undefined;
  if (raw.split("/").some((segment) => segment === "..")) return undefined;
  return raw;
}

export function repositoryRouteOptions({ tab, provider, revision, path }: RepositorySearchParams): {
  initialTab: RepositoryTab;
  initialProvider: "claude" | "codex" | undefined;
  initialRevisionId: string | undefined;
  initialPath: string | undefined;
} {
  return {
    initialTab: repositoryTab(tab) ?? "overview",
    initialProvider: provider === "claude" || provider === "codex" ? provider : undefined,
    initialRevisionId: typeof revision === "string" && /^ctx-\d{3,9}$/u.test(revision) ? revision : undefined,
    initialPath: repositoryFilePath(path),
  };
}
