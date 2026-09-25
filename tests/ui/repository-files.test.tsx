import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileHistoryResponse, RepositoryFilesResponse } from "../../shared/repository-files-contract";
import { RepositoryFilesTab } from "../../app/components/repositories/RepositoryFilesTab";
import type { FileHistoryPanelProps } from "../../app/components/repositories/FileHistoryPanel";
import type { FileTreeProps } from "../../app/components/repositories/FileTree";

const { useRepositoryFiles, useFileHistory } = vi.hoisted(() => ({
  useRepositoryFiles: vi.fn<(...args: unknown[]) => RepositoryFilesResponse | null>(() => null),
  useFileHistory: vi.fn<(...args: unknown[]) => FileHistoryResponse | null>(() => null),
}));
vi.mock("../../app/repository-files-store", () => ({ useRepositoryFiles, useFileHistory }));

// FileTree and FileHistoryPanel are being written in parallel (implement-controls); this file
// tests RepositoryFilesTab's own toolbar/toggle/fetch-target logic and the props it hands them,
// never their rendered internals (see the plan's implement-tabs brief).
const { FileTreeMock, FileHistoryPanelMock } = vi.hoisted(() => ({
  FileTreeMock: vi.fn<(props: FileTreeProps) => void>(),
  FileHistoryPanelMock: vi.fn<(props: FileHistoryPanelProps) => void>(),
}));
vi.mock("../../app/components/repositories/FileTree", () => ({
  FileTree: (props: FileTreeProps) => { FileTreeMock(props); return null; },
}));
vi.mock("../../app/components/repositories/FileHistoryPanel", () => ({
  FileHistoryPanel: (props: FileHistoryPanelProps) => { FileHistoryPanelMock(props); return null; },
}));

const REPOSITORY_ID = "repo-0123456789abcdef01234567";

function filesResponse(overrides: Partial<RepositoryFilesResponse> = {}): RepositoryFilesResponse {
  return {
    kind: "files",
    revision: 1,
    readiness: "ready",
    repositoryId: REPOSITORY_ID,
    files: [
      { fileId: "f1", path: "app/Dashboard.tsx", sessionCount: 3, deleted: false },
      { fileId: "f2", path: "app/unused.ts", sessionCount: 0, deleted: false },
      { fileId: "f3", path: "app/removed.ts", sessionCount: 2, deleted: true },
    ],
    folders: [{ path: "app", sessionCount: 3 }],
    historicalFolders: [{ path: "app", sessionCount: 4 }],
    truncated: false,
    ...overrides,
  };
}

function renderFilesTab(overrides: { path?: string | null; onSelectPath?: (path: string | null) => void } = {}) {
  const onSelectPath = overrides.onSelectPath ?? vi.fn();
  const view = render(<RepositoryFilesTab repositoryId={REPOSITORY_ID} repositoryLabel="pomegr" path={overrides.path ?? null} onSelectPath={onSelectPath} />);
  return { ...view, onSelectPath };
}

describe("RepositoryFilesTab", () => {
  beforeEach(() => {
    useRepositoryFiles.mockReset();
    useRepositoryFiles.mockReturnValue(filesResponse());
    useFileHistory.mockReset();
    useFileHistory.mockReturnValue(null);
    FileTreeMock.mockReset();
    FileHistoryPanelMock.mockReset();
  });

  it("renders the search field and both toggles, and asks the store for this repository's files", () => {
    renderFilesTab();
    expect(useRepositoryFiles).toHaveBeenCalledWith(REPOSITORY_ID);
    expect(screen.getByRole("searchbox", { name: "Find a file anywhere in pomegr" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "With session history only" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Include historical files" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Counts are recorded sessions per file")).toBeInTheDocument();
  });

  it("maps every non-deleted file to FileTree by default, muting files with no session history", () => {
    renderFilesTab();
    const treeProps = FileTreeMock.mock.calls.at(-1)![0];
    expect(treeProps.scope).toBe("repository");
    expect(treeProps.rootLabel).toBe("pomegr");
    expect(treeProps.files).toEqual([
      { path: "app/Dashboard.tsx", fileId: "f1", sessionCount: 3, muted: false },
      { path: "app/unused.ts", fileId: "f2", sessionCount: 0, muted: true },
    ]);
    expect(treeProps.folderCounts).toEqual(new Map([["app", 3]]));
  });

  it("With session history only filters to sessionCount > 0", async () => {
    renderFilesTab();
    await userEvent.click(screen.getByRole("button", { name: "With session history only" }));
    expect(screen.getByRole("button", { name: "With session history only" })).toHaveAttribute("aria-pressed", "true");
    const treeProps = FileTreeMock.mock.calls.at(-1)![0];
    expect(treeProps.files).toEqual([{ path: "app/Dashboard.tsx", fileId: "f1", sessionCount: 3, muted: false }]);
  });

  it("Include historical files includes deleted files and switches folderCounts to historicalFolders", async () => {
    renderFilesTab();
    await userEvent.click(screen.getByRole("button", { name: "Include historical files" }));
    expect(screen.getByRole("button", { name: "Include historical files" })).toHaveAttribute("aria-pressed", "true");
    const treeProps = FileTreeMock.mock.calls.at(-1)![0];
    expect(treeProps.files).toEqual([
      { path: "app/Dashboard.tsx", fileId: "f1", sessionCount: 3, muted: false },
      { path: "app/unused.ts", fileId: "f2", sessionCount: 0, muted: true },
      { path: "app/removed.ts", fileId: "f3", sessionCount: 2, muted: true },
    ]);
    expect(treeProps.folderCounts).toEqual(new Map([["app", 4]]));
  });

  it("filters by path substring and expands matches", async () => {
    renderFilesTab();
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a file anywhere in pomegr" }), "dashboard");
    const treeProps = FileTreeMock.mock.calls.at(-1)![0];
    expect(treeProps.files).toEqual([{ path: "app/Dashboard.tsx", fileId: "f1", sessionCount: 3, muted: false }]);
    expect(treeProps.expandAll).toBe(true);
  });

  it("calls onSelectPath when a tree row is selected", () => {
    const { onSelectPath } = renderFilesTab();
    const treeProps = FileTreeMock.mock.calls.at(-1)![0];
    treeProps.onSelect({ path: "app/Dashboard.tsx", fileId: "f1" });
    expect(onSelectPath).toHaveBeenCalledWith("app/Dashboard.tsx");
  });

  it("resolves the file-history target from the listing's own fileId, falling back to path when unmatched", () => {
    renderFilesTab({ path: "app/Dashboard.tsx" });
    expect(useFileHistory).toHaveBeenLastCalledWith(REPOSITORY_ID, { fileId: "f1" });

    renderFilesTab({ path: "app/never-recorded.ts" });
    expect(useFileHistory).toHaveBeenLastCalledWith(REPOSITORY_ID, { path: "app/never-recorded.ts" });

    renderFilesTab({ path: null });
    expect(useFileHistory).toHaveBeenLastCalledWith(REPOSITORY_ID, null);
  });

  it("passes repository-side props to FileHistoryPanel with a null working-tree status", () => {
    const history = { kind: "history" as const, revision: 1, readiness: "ready" as const, repositoryId: REPOSITORY_ID, fileId: "f1", path: "app/Dashboard.tsx", sessions: [], unattributedChanges: 0, truncated: false };
    useFileHistory.mockReturnValue(history);
    renderFilesTab({ path: "app/Dashboard.tsx" });
    const panelProps = FileHistoryPanelMock.mock.calls.at(-1)![0];
    expect(panelProps.repositoryLabel).toBe("pomegr");
    expect(panelProps.path).toBe("app/Dashboard.tsx");
    expect(panelProps.workingTreeStatus).toBeNull();
    expect(panelProps.history).toBe(history);
  });

  it("gives FileTree the unavailable/rebuilding empty text while the listing is not ready", () => {
    useRepositoryFiles.mockReturnValue(filesResponse({ readiness: "unavailable", files: [] }));
    renderFilesTab();
    expect(FileTreeMock.mock.calls.at(-1)![0].emptyText).toBe("File history is unavailable.");

    useRepositoryFiles.mockReturnValue(filesResponse({ readiness: "rebuilding", files: [] }));
    renderFilesTab();
    expect(FileTreeMock.mock.calls.at(-1)![0].emptyText).toBe("File history is rebuilding.");
  });

  it("treats a null response (before the first commit) as loading, passing no files", () => {
    useRepositoryFiles.mockReturnValue(null);
    renderFilesTab();
    const treeProps = FileTreeMock.mock.calls.at(-1)![0];
    expect(treeProps.files).toEqual([]);
    expect(treeProps.folderCounts).toEqual(new Map());
  });
});
