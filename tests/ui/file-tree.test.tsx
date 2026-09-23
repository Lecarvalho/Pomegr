import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileHistoryPanel } from "../../app/components/repositories/FileHistoryPanel";
import { FileTree, type FileTreeFile } from "../../app/components/repositories/FileTree";
import type { FileHistoryResponse, FileHistorySession } from "../../shared/repository-files-contract";

function sessionFixture(overrides: Partial<FileHistorySession> = {}): FileHistorySession {
  return {
    sessionId: "claude:session-1",
    title: "Sample session",
    provider: "claude",
    live: false,
    kind: "edited",
    editCount: 2,
    newestAt: "2026-09-20T09:31:00.000Z",
    agents: [{ id: "primary", label: "Primary" }],
    pathAtTime: null,
    ...overrides,
  };
}

function historyFixture(overrides: Partial<FileHistoryResponse> = {}): FileHistoryResponse {
  return {
    kind: "history",
    revision: 1,
    readiness: "ready",
    repositoryId: "repo-0123456789abcdef01234567",
    fileId: "f10",
    path: "app/Dashboard.tsx",
    sessions: [sessionFixture()],
    unattributedChanges: 0,
    truncated: false,
    ...overrides,
  };
}

function buttonIndex(name: string) {
  return screen.getAllByRole("button").findIndex((button) => button.textContent?.includes(name));
}

describe("FileTree", () => {
  it("orders folders before files, alphabetically, at each level", () => {
    const files: FileTreeFile[] = [
      { path: "b-folder/one.ts", fileId: "f1" },
      { path: "a-file.ts", fileId: "f2" },
      { path: "a-folder/two.ts", fileId: "f3" },
    ];
    render(<FileTree scope="session" rootLabel="Pomegr" files={files} selectedPath={null} onSelect={() => {}} emptyText="Nothing" />);
    const order = screen.getAllByRole("button").map((button) => button.textContent);
    expect(order).toEqual(["a-folder", "two.ts", "b-folder", "one.ts", "a-file.ts"]);
  });

  it("expands ancestors of the selection while leaving unrelated nested folders collapsed", () => {
    const files: FileTreeFile[] = [
      { path: "app/components/dashboard/Alpha.tsx", fileId: "f1" },
      { path: "app/components/dashboard/Panel.tsx", fileId: "f2" },
      { path: "app/other/Solo.ts", fileId: "f3" },
    ];
    render(<FileTree scope="session" rootLabel="Pomegr" files={files} selectedPath="app/components/dashboard/Alpha.tsx" onSelect={() => {}} emptyText="Nothing" />);
    expect(screen.getByRole("button", { name: "app" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "components" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "dashboard" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "other" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Solo.ts")).not.toBeInTheDocument();
  });

  it("collapses a top-level folder with more than 12 files by default, and a click expands it", () => {
    const manyFiles: FileTreeFile[] = Array.from({ length: 13 }, (_, index) => ({ path: `big/file-${index}.ts`, fileId: `f${index}` }));
    render(<FileTree scope="session" rootLabel="Pomegr" files={manyFiles} selectedPath={null} onSelect={() => {}} emptyText="Nothing" />);
    const folder = screen.getByRole("button", { name: "big" });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("file-0.ts")).not.toBeInTheDocument();
    fireEvent.click(folder);
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("file-0.ts")).toBeInTheDocument();
  });

  it("shows the small status chip with the right tone, and no chip when there is no status", () => {
    const files: FileTreeFile[] = [
      { path: "mod.ts", fileId: "f1", status: "M" },
      { path: "new.ts", fileId: "f2", status: "??" },
      { path: "del.ts", fileId: "f3", status: "D" },
      { path: "clean.ts", fileId: "f4", status: null },
    ];
    render(<FileTree scope="session" rootLabel="Pomegr" files={files} selectedPath={null} onSelect={() => {}} emptyText="Nothing" />);
    expect(screen.getByText("MOD")).toHaveClass("commandChip", "small", "warning");
    expect(screen.getByText("NEW")).toHaveClass("commandChip", "small", "positive");
    const del = screen.getByText("DEL");
    expect(del).toHaveClass("commandChip", "small");
    expect(del).not.toHaveClass("warning");
    expect(del).not.toHaveClass("positive");
    const cleanRow = screen.getByRole("button", { name: "clean.ts" });
    expect(within(cleanRow).queryByText(/^(MOD|NEW|DEL|REN)$/)).not.toBeInTheDocument();
  });

  it("hides Changed elsewhere when empty and renders it flat and sorted, with status chips, otherwise", () => {
    const { rerender } = render(<FileTree scope="session" rootLabel="Pomegr" files={[]} selectedPath={null} onSelect={() => {}} emptyText="Nothing touched" />);
    expect(screen.queryByText("Changed elsewhere")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing touched")).toBeInTheDocument();

    const elsewhere: FileTreeFile[] = [
      { path: "z/late.md", fileId: null, status: "M" },
      { path: "a/early.md", fileId: null, status: "??" },
    ];
    rerender(<FileTree scope="session" rootLabel="Pomegr" files={[{ path: "touched.ts", fileId: "f1", status: "M" }]} elsewhere={elsewhere} selectedPath={null} onSelect={() => {}} emptyText="Nothing touched" />);
    expect(screen.getByText("Changed elsewhere")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a\/early\.md/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /z\/late\.md/ })).toBeInTheDocument();
    expect(buttonIndex("a/early.md")).toBeLessThan(buttonIndex("z/late.md"));
  });

  it("repository scope shows distinct-session counts and mutes files with no recorded history", () => {
    const files: FileTreeFile[] = [
      { path: "seen.ts", fileId: "f1", sessionCount: 4 },
      { path: "unseen.ts", fileId: "f2", sessionCount: 0, muted: true },
    ];
    const folderCounts = new Map([["src", 2]]);
    render(<FileTree scope="repository" rootLabel="Pomegr" files={files} folderCounts={folderCounts} selectedPath={null} onSelect={() => {}} emptyText="Nothing" />);
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    const seenRow = screen.getByRole("button", { name: "seen.ts4" });
    expect(within(seenRow).getByText("4")).toBeInTheDocument();
    const unseenRow = screen.getByRole("button", { name: "unseen.ts" });
    expect(unseenRow).toHaveClass("isMuted");
    expect(within(unseenRow).queryByText("0")).not.toBeInTheDocument();
  });

  it("calls onSelect with the file and marks the selected row", () => {
    const onSelect = vi.fn();
    render(<FileTree scope="session" rootLabel="Pomegr" files={[{ path: "one.ts", fileId: "f1", status: "M" }]} selectedPath="one.ts" onSelect={onSelect} emptyText="Nothing" />);
    const row = screen.getByRole("button", { name: /one\.ts/ });
    expect(row).toHaveClass("isSelected");
    expect(row).toHaveAttribute("aria-current", "true");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith({ path: "one.ts", fileId: "f1", status: "M" });
  });

  it("expandAll opens every folder regardless of size", () => {
    const manyFiles: FileTreeFile[] = Array.from({ length: 13 }, (_, index) => ({ path: `big/file-${index}.ts`, fileId: `f${index}` }));
    render(<FileTree scope="session" rootLabel="Pomegr" files={manyFiles} selectedPath={null} onSelect={() => {}} expandAll emptyText="Nothing" />);
    expect(screen.getByRole("button", { name: "big" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("file-0.ts")).toBeInTheDocument();
  });
});

describe("FileHistoryPanel", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-23T18:00:00.000Z")); });
  afterEach(() => vi.useRealTimers());

  it("renders the no-file-selected state", () => {
    render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path={null} workingTreeStatus={null} history={null} />);
    expect(screen.getByText("Select a file to see its recorded sessions.")).toBeInTheDocument();
  });

  it("shows a loading skeleton while history is null, and readiness text for rebuilding/unavailable", () => {
    const { rerender } = render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={null} />);
    expect(screen.getByText("Loading file history…")).toBeInTheDocument();

    rerender(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={historyFixture({ readiness: "rebuilding", sessions: [] })} />);
    expect(screen.getByText("File history is rebuilding.")).toBeInTheDocument();

    rerender(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={historyFixture({ readiness: "unavailable", sessions: [] })} />);
    expect(screen.getByText("File history is unavailable.")).toBeInTheDocument();
  });

  it("shows the empty-evidence message when ready with zero sessions", () => {
    render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={historyFixture({ sessions: [], fileId: null })} />);
    expect(screen.getByText("No recorded sessions changed this file.")).toBeInTheDocument();
  });

  it("renders the header breadcrumb, working-tree chip, and session-side link with the encoded path", () => {
    const path = "app/components/Dashboard.tsx";
    render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path={path} workingTreeStatus="M" history={historyFixture({ path })} />);
    expect(screen.getByText("Dashboard.tsx")).toBeInTheDocument();
    expect(screen.getByText("app/components/")).toBeInTheDocument();
    expect(screen.getByText("MOD in working tree")).toHaveClass("commandChip", "warning");
    const link = screen.getByRole("link", { name: /All history on repository page/ });
    expect(link).toHaveAttribute("href", "/repositories/repo-0123456789abcdef01234567?tab=files&path=app%2Fcomponents%2FDashboard.tsx");
  });

  it("labels a historical session's recorded status as at last live check, never the working tree", () => {
    render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="a.ts" workingTreeStatus="M" statusRecorded history={historyFixture({ path: "a.ts" })} />);
    expect(screen.getByText("MOD at last live check")).toHaveClass("commandChip", "warning");
    expect(screen.queryByText(/in working tree/)).not.toBeInTheDocument();
  });

  it("shows Copy path on the repository side and copies the selected path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<FileHistoryPanel side="repository" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={historyFixture()} />);
      fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
      expect(writeText).toHaveBeenCalledWith("app/Dashboard.tsx");
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
    }
  });

  it("renders entries with kind tone, edit counts, the this-session/live chips, and a moved entry's old path", () => {
    const history = historyFixture({
      sessions: [
        sessionFixture({ sessionId: "claude:current", title: "Current work", kind: "edited", editCount: 2 }),
        sessionFixture({ sessionId: "claude:other-live", title: "Other live session", live: true, kind: "created", editCount: 0 }),
        sessionFixture({ sessionId: "claude:moved", title: "Moved the file", kind: "moved", editCount: 1, pathAtTime: "app/OldDashboard.tsx" }),
        sessionFixture({ sessionId: "claude:unknown-agents", title: "Unknown agents", kind: "deleted", editCount: 0, agents: [{ id: "a1", label: null }, { id: "a2", label: null }] }),
      ],
    });
    render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={history} currentSessionId="claude:current" />);

    expect(screen.getByText("this session")).toBeInTheDocument();
    expect(screen.getByText("live")).toHaveClass("commandChip", "positive");
    expect(screen.getByText("Edited")).toHaveClass("commandChip", "positive");
    expect(screen.getByText("Created")).toHaveClass("commandChip", "info");
    expect(screen.getByText("Moved")).toHaveClass("commandChip");
    expect(screen.getByText("Deleted")).toHaveClass("commandChip", "warning");
    expect(screen.getByText("2 edits")).toBeInTheDocument();
    expect(screen.getByText("1 edit")).toBeInTheDocument();
    expect(screen.getByText("as app/OldDashboard.tsx")).toBeInTheDocument();
    expect(screen.getByText("2 agents")).toBeInTheDocument();
    const currentEntry = screen.getByText("Current work").closest("article");
    expect(currentEntry).toHaveClass("isCurrentSession");
  });

  it("shows a provider filter only when more than one provider is present, and narrows the entries", () => {
    const single = historyFixture({ sessions: [sessionFixture({ provider: "claude" })] });
    const { rerender } = render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={single} />);
    expect(screen.queryByRole("group", { name: "Filter by provider" })).not.toBeInTheDocument();

    const mixed = historyFixture({
      sessions: [
        sessionFixture({ sessionId: "claude:a", title: "Claude session", provider: "claude" }),
        sessionFixture({ sessionId: "codex:b", title: "Codex session", provider: "codex" }),
      ],
    });
    rerender(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={mixed} />);
    expect(screen.getByText("Claude session")).toBeInTheDocument();
    expect(screen.getByText("Codex session")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.queryByText("Claude session")).not.toBeInTheDocument();
    expect(screen.getByText("Codex session")).toBeInTheDocument();
  });

  it("shows the unattributed-changes line only when the count is positive", () => {
    const { rerender } = render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={historyFixture({ unattributedChanges: 0 })} />);
    expect(screen.queryByText(/without session attribution/)).not.toBeInTheDocument();

    rerender(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={historyFixture({ unattributedChanges: 3 })} />);
    expect(screen.getByText("3 changes without session attribution (moves seen in Git)")).toBeInTheDocument();
  });

  it("resets the provider filter when the selected path changes", () => {
    const mixed = historyFixture({
      sessions: [
        sessionFixture({ sessionId: "claude:a", title: "Claude session", provider: "claude" }),
        sessionFixture({ sessionId: "codex:b", title: "Codex session", provider: "codex" }),
      ],
    });
    const { rerender } = render(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Dashboard.tsx" workingTreeStatus={null} history={mixed} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.queryByText("Claude session")).not.toBeInTheDocument();

    rerender(<FileHistoryPanel side="session" repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/Other.tsx" workingTreeStatus={null} history={mixed} />);
    expect(screen.getByText("Claude session")).toBeInTheDocument();
    expect(screen.getByText("Codex session")).toBeInTheDocument();
  });
});
