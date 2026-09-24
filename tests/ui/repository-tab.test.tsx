import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest, SessionSummary } from "../../shared/monitor-contract";
import type { RepositoryDomain } from "../../shared/session-domain-contract";
import type { FileHistoryResponse } from "../../shared/repository-files-contract";
import { RepositoryTab, type RepositoryTabProps } from "../../app/components/dashboard/RepositoryTab";
import type { SessionFilePanel } from "../../app/components/dashboard/SessionFilePanel";
import type { FileTreeProps } from "../../app/components/repositories/FileTree";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";

const { useSessionDomain } = vi.hoisted(() => ({ useSessionDomain: vi.fn() }));
vi.mock("../../app/session-domain-store", () => ({ useSessionDomain }));

const { useFileHistory } = vi.hoisted(() => ({ useFileHistory: vi.fn<(...args: unknown[]) => FileHistoryResponse | null>(() => null) }));
vi.mock("../../app/repository-files-store", () => ({ useFileHistory }));

// This file tests RepositoryTab's own toolbar/segment/selection logic and the props it hands
// FileTree and SessionFilePanel, never their rendered internals.
type SessionFilePanelProps = Parameters<typeof SessionFilePanel>[0];
const { FileTreeMock, SessionFilePanelMock } = vi.hoisted(() => ({
  FileTreeMock: vi.fn<(props: FileTreeProps) => void>(),
  SessionFilePanelMock: vi.fn<(props: SessionFilePanelProps) => void>(),
}));
vi.mock("../../app/components/repositories/FileTree", () => ({
  FileTree: (props: FileTreeProps) => { FileTreeMock(props); return null; },
}));
vi.mock("../../app/components/dashboard/SessionFilePanel", () => ({
  SessionFilePanel: (props: SessionFilePanelProps) => { SessionFilePanelMock(props); return null; },
}));

function renderTab(props: RepositoryTabProps, sessions: SessionSummary[] = []) {
  return render(<LiveClockProvider running={false}><SessionCatalogProvider sessions={sessions}><RepositoryTab {...props} /></SessionCatalogProvider></LiveClockProvider>);
}

const SESSION_ID = "claude:repo-tab";
const REPOSITORY_ID = "repo-0123456789abcdef01234567";

type Repository = NonNullable<RepositoryDomain["repository"]>;
type FileHistoryFiles = RepositoryDomain["fileHistory"]["files"];

function repository(overrides: Partial<Repository> = {}): Repository {
  return {
    available: true,
    branch: "feat/ia-progressive-disclosure",
    files: [],
    historical: false,
    isMain: false,
    comparison: { branch: "origin/main", kind: "base", ahead: 2, behind: 0, integrated: false },
    commits: [{ hash: "abc1234", subject: "Should never render on the session page", committedAt: "2026-09-22T11:00:00.000Z" }],
    remote: { status: "ready", checkedAt: "2026-09-22T12:00:00.000Z" },
    ...overrides,
  };
}

const draftPullRequest: PullRequest = {
  host: "github", repository: "PomegrHQ/pomegr", number: 24, title: "IA redesign",
  url: "https://github.com/PomegrHQ/pomegr/pull/24", state: "open", draft: true,
  headBranch: "feat/ia-progressive-disclosure", baseBranch: "main",
  additions: 842, deletions: 1117, updatedAt: "2026-09-22T12:00:00.000Z", association: "session",
};

// Cast at the boundary rather than annotating the literal: shared/session-domain-contract.ts's
// RepositoryDomain gains `recordedAt`/`commitsInSession`/`gitTasks` from a parallel monitor
// change (see the implement-ui brief); this fixture must build a complete Fixed-interface object
// either way without tripping excess-property checks before that lands.
function domain(overrides: Record<string, unknown> = {}): RepositoryDomain {
  return {
    domain: "repository",
    sessionId: SESSION_ID,
    revision: 1,
    readiness: "ready",
    observedAt: "2026-09-22T12:00:00.000Z",
    repositoryId: REPOSITORY_ID,
    contextInventoryRef: null,
    repository: repository(),
    pullRequests: { status: "ready", checkedAt: "2026-09-22T12:00:00.000Z", items: [draftPullRequest] },
    recordedAt: null,
    commitsInSession: 2,
    gitTasks: { total: 9, failed: 0 },
    gitObservedFiles: null,
    fileHistory: { readiness: "unavailable", files: [], truncated: false },
    ...overrides,
  } as RepositoryDomain;
}

function touchedFile(overrides: Partial<FileHistoryFiles[number]> = {}): FileHistoryFiles[number] {
  return { fileId: "f1", path: "app/Dashboard.tsx", kind: "edited", changeCount: 2, lastObservedAt: "2026-09-22T12:00:00.000Z", ...overrides };
}

function result(data: RepositoryDomain | null, error: string | null = null, unavailable = false) {
  return { data, error, fetching: false, connected: true, unavailable, revalidate: vi.fn() };
}

describe("RepositoryTab", () => {
  beforeEach(() => {
    useSessionDomain.mockReset();
    useFileHistory.mockReset();
    useFileHistory.mockReturnValue(null);
    FileTreeMock.mockReset();
    SessionFilePanelMock.mockReset();
  });

  it("renders the live top bar with comparison, PR, and line-2 evidence, and no commit list", () => {
    useSessionDomain.mockReturnValue(result(domain()));
    renderTab({ sessionId: SESSION_ID, historical: false });

    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: SESSION_ID, domain: "repository" }, { historical: false, enabled: true });
    expect(screen.getByText("feat/ia-progressive-disclosure")).toBeInTheDocument();
    expect(screen.getByText("2 ahead of origin/main")).toBeInTheDocument();
    expect(screen.getByText("Draft PR #24")).toBeInTheDocument();
    expect(screen.getByText("Both commits in this session")).toBeInTheDocument();
    // Each line-2 part after the first carries a leading " · " separator inside the same node.
    expect(screen.getByText(/PR \+842 −1,117/)).toBeInTheDocument();
    expect(screen.getByText(/9 git shell tasks, 0 failed/)).toBeInTheDocument();

    // No commit list or PR popover button anywhere on the session page.
    expect(screen.queryByText("Should never render on the session page")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /PR #24/ })).not.toBeInTheDocument();
    expect(screen.getByText("Draft PR #24").tagName).toBe("SPAN");
  });

  it("omits line-2 parts and the comparison chip when their evidence is absent, never showing a zero or dash", () => {
    useSessionDomain.mockReturnValue(result(domain({
      repository: repository({ comparison: null, remote: { status: "unavailable", checkedAt: null } }),
      pullRequests: { status: "unavailable", checkedAt: null, items: [] },
      commitsInSession: null,
      gitTasks: null,
    })));
    renderTab({ sessionId: SESSION_ID, historical: false });

    expect(screen.getByText("Remote comparison unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/ahead|behind|Up to date|Integrated/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
    expect(screen.queryByText(/commits? in this session/)).not.toBeInTheDocument();
    expect(screen.queryByText(/git shell task/)).not.toBeInTheDocument();
    expect(screen.queryByText(/remote checked/)).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows the recorded-snapshot caption for a historical session with a snapshot", () => {
    useSessionDomain.mockReturnValue(result(domain({
      repository: repository({
        historical: true,
        files: [{ status: " M", path: "app/Dashboard.tsx" }],
        remote: { status: "ready", checkedAt: "2026-09-21T09:00:00.000Z" },
      }),
      recordedAt: "2026-09-21T09:00:05.000Z",
    })));
    renderTab({ sessionId: SESSION_ID, historical: true });

    expect(screen.getByText("Recorded at the session's last live check")).toBeInTheDocument();
  });

  it("shows only the branch and the unrecorded notice for a historical session with no snapshot", () => {
    useSessionDomain.mockReturnValue(result(domain({
      repository: repository({ historical: true, comparison: null, remote: { status: "unavailable", checkedAt: null } }),
      recordedAt: null,
      pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    })));
    renderTab({ sessionId: SESSION_ID, historical: true });

    expect(screen.getByText("feat/ia-progressive-disclosure")).toBeInTheDocument();
    expect(screen.getByText("Repository state was not recorded for this session.")).toBeInTheDocument();
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
    // No files toolbar without a recorded snapshot.
    expect(screen.queryByRole("group", { name: "File segment" })).not.toBeInTheDocument();
  });

  it("shows the empty-repository message when no repository was detected", () => {
    useSessionDomain.mockReturnValue(result(domain({ repository: repository({ available: false }) })));
    renderTab({ sessionId: SESSION_ID, historical: false });
    expect(screen.getByText("No Git repository detected for this session.")).toBeInTheDocument();
  });

  it("links the quiet Git action to the repository page's Git tab and hides it without a repositoryId", () => {
    useSessionDomain.mockReturnValue(result(domain()));
    const { rerender } = renderTab({ sessionId: SESSION_ID, historical: false });
    expect(screen.getByRole("link", { name: /Git tab on repository page/ })).toHaveAttribute("href", `/repositories/${REPOSITORY_ID}?tab=git`);

    useSessionDomain.mockReturnValue(result(domain({ repositoryId: null })));
    rerender(<LiveClockProvider running={false}><SessionCatalogProvider sessions={[]}><RepositoryTab sessionId={SESSION_ID} historical={false} /></SessionCatalogProvider></LiveClockProvider>);
    expect(screen.queryByRole("link", { name: /Git tab on repository page/ })).not.toBeInTheDocument();
    // File history needs a linked repository id; the files body does not render without one.
    expect(screen.getByText("File history requires a linked repository.")).toBeInTheDocument();
  });

  it("shows a loading state before evidence arrives and an unavailable state once the monitor confirms none", () => {
    useSessionDomain.mockReturnValue(result(null));
    const loading = renderTab({ sessionId: SESSION_ID, historical: false });
    expect(screen.getByText("Loading repository evidence…")).toBeInTheDocument();
    loading.unmount();

    useSessionDomain.mockReturnValue(result(null, null, true));
    renderTab({ sessionId: SESSION_ID, historical: false });
    expect(screen.getByText("Repository evidence is unavailable for this session.")).toBeInTheDocument();
  });

  describe("files body (F17/F18)", () => {
    function domainWithFiles(overrides: Record<string, unknown> = {}) {
      return domain({
        repository: repository({
          files: [
            { status: " M", path: "app/Dashboard.tsx" }, // touched, currently modified
            { status: "??", path: "app/new-file.ts" }, // uncommitted, not touched this session
          ],
        }),
        fileHistory: { readiness: "ready", files: [touchedFile()], truncated: false },
        ...overrides,
      });
    }

    it("renders the search field and segmented counts, defaulting to Touched here", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false });

      expect(screen.getByRole("searchbox", { name: "Find a file touched in this session" })).toBeInTheDocument();
      expect(screen.getByText("Beta")).toHaveClass("commandChip");
      const segment = screen.getByRole("group", { name: "File segment" });
      expect(within(segment).getByRole("button", { name: "Touched here 1" })).toHaveAttribute("aria-pressed", "true");
      expect(within(segment).getByRole("button", { name: "Uncommitted 2" })).toHaveAttribute("aria-pressed", "false");
      expect(within(segment).getByRole("button", { name: "Changed elsewhere 1" })).toHaveAttribute("aria-pressed", "false");

      const treeProps = FileTreeMock.mock.calls.at(-1)![0];
      expect(treeProps.scope).toBe("session");
      expect(treeProps.files).toEqual([{ path: "app/Dashboard.tsx", fileId: "f1", status: " M", recordedKind: "edited" }]);
      expect(treeProps.elsewhere).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
    });

    it("switches to Uncommitted and Changed elsewhere on click, changing the files passed to FileTree", async () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false });

      await userEvent.click(screen.getByRole("button", { name: "Uncommitted 2" }));
      let treeProps = FileTreeMock.mock.calls.at(-1)![0];
      expect(treeProps.files).toEqual([
        { path: "app/Dashboard.tsx", fileId: "f1", status: " M" },
        { path: "app/new-file.ts", fileId: null, status: "??" },
      ]);
      expect(treeProps.elsewhere).toBeUndefined();

      await userEvent.click(screen.getByRole("button", { name: "Changed elsewhere 1" }));
      treeProps = FileTreeMock.mock.calls.at(-1)![0];
      expect(treeProps.files).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
      expect(treeProps.elsewhere).toBeUndefined();
    });

    it("filters the active segment by the search query and expands matches", async () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false });

      await userEvent.type(screen.getByRole("searchbox", { name: "Find a file touched in this session" }), "new-file");
      const treeProps = FileTreeMock.mock.calls.at(-1)![0];
      // Search stays on the current segment (Touched here); "new-file" only matches the elsewhere group.
      expect(treeProps.files).toEqual([]);
      expect(treeProps.elsewhere).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
      expect(treeProps.expandAll).toBe(true);
    });

    it("calls onSelectPath when a tree row is selected", () => {
      const onSelectPath = vi.fn();
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false, onSelectPath });

      const treeProps = FileTreeMock.mock.calls.at(-1)![0];
      treeProps.onSelect({ path: "app/Dashboard.tsx", fileId: "f1" });
      expect(onSelectPath).toHaveBeenCalledWith("app/Dashboard.tsx");
    });

    it("never fetches cross-session file history; the panel gets only this session's evidence", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false, selectedPath: "app/Dashboard.tsx" });
      renderTab({ sessionId: SESSION_ID, historical: false, selectedPath: "app/new-file.ts" });
      expect(useFileHistory).not.toHaveBeenCalled();
    });

    it("rejects an unsafe deep-linked path before selecting anything", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false, selectedPath: "../secret" });
      const treeProps = FileTreeMock.mock.calls.at(-1)![0];
      expect(treeProps.selectedPath).toBeNull();
      expect(SessionFilePanelMock.mock.calls.at(-1)![0].path).toBeNull();
    });

    it("passes the working-tree status and this session's recorded change to SessionFilePanel", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false, selectedPath: "app/Dashboard.tsx" });

      const panelProps = SessionFilePanelMock.mock.calls.at(-1)![0];
      expect(panelProps.repositoryId).toBe(REPOSITORY_ID);
      expect(panelProps.path).toBe("app/Dashboard.tsx");
      expect(panelProps.workingTreeStatus).toBe(" M");
      expect(panelProps.recorded?.fileId).toBe("f1");
      expect(panelProps.gitObserved).toBeNull();
    });

    it("passes the Git-observed entry when no tool recorded the selected file", () => {
      const committedOnly = { path: "app/committed-only.ts", source: "committed", change: "added" } as const;
      useSessionDomain.mockReturnValue(result(domainWithFiles({ gitObservedFiles: { files: [committedOnly], truncated: false } })));
      renderTab({ sessionId: SESSION_ID, historical: false, selectedPath: "app/committed-only.ts" });
      const panelProps = SessionFilePanelMock.mock.calls.at(-1)![0];
      expect(panelProps.recorded).toBeNull();
      expect(panelProps.gitObserved).toEqual(committedOnly);
    });

    it("uses the catalog project as the tree root label, falling back to Repository when unknown", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false }, [{
        id: SESSION_ID, provider: "claude", source: "Claude Code", title: "t", project: "pomegr",
        updatedAt: "2026-09-22T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working",
        summaryReadiness: "ready", agentCount: 1, activeAgentCount: 1, latestContextTotal: 100, progress: null, currentActivity: null,
      }]);
      expect(FileTreeMock.mock.calls.at(-1)![0].rootLabel).toBe("pomegr");

      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false });
      expect(FileTreeMock.mock.calls.at(-1)![0].rootLabel).toBe("Repository");
    });

    it("shows a loading skeleton for Touched here while file history is still loading, without rendering FileTree", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles({ fileHistory: { readiness: "loading", files: [], truncated: false } })));
      FileTreeMock.mockClear();
      renderTab({ sessionId: SESSION_ID, historical: false });
      expect(screen.getByLabelText("Loading file history")).toBeInTheDocument();
      expect(FileTreeMock).not.toHaveBeenCalled();
    });

    it("gives an unavailable/rebuilding empty text without a skeleton once file history has answered", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles({ fileHistory: { readiness: "unavailable", files: [], truncated: false } })));
      renderTab({ sessionId: SESSION_ID, historical: false });
      expect(FileTreeMock.mock.calls.at(-1)![0].emptyText).toBe("File history is unavailable.");

      useSessionDomain.mockReturnValue(result(domainWithFiles({ fileHistory: { readiness: "rebuilding", files: [], truncated: false } })));
      renderTab({ sessionId: SESSION_ID, historical: false });
      expect(FileTreeMock.mock.calls.at(-1)![0].emptyText).toBe("File history is rebuilding.");
    });

    describe("Git-observed files", () => {
      it("merges a new Git-observed path into Touched here, tags it, and removes it from Changed elsewhere/counts, without duplicating an already-recorded path", () => {
        useSessionDomain.mockReturnValue(result(domainWithFiles({
          gitObservedFiles: {
            files: [
              { path: "app/Dashboard.tsx", source: "committed", change: "modified" }, // already recorded; stays a plain recorded row
              { path: "app/new-file.ts", source: "uncommitted", change: null }, // not recorded; gains the glyph, moves out of elsewhere
            ],
            truncated: false,
          },
        })));
        renderTab({ sessionId: SESSION_ID, historical: false });

        const segment = screen.getByRole("group", { name: "File segment" });
        expect(within(segment).getByRole("button", { name: "Touched here 2" })).toBeInTheDocument();
        expect(within(segment).getByRole("button", { name: "Uncommitted 2" })).toBeInTheDocument();
        expect(within(segment).getByRole("button", { name: "Changed elsewhere 0" })).toBeInTheDocument();

        const treeProps = FileTreeMock.mock.calls.at(-1)![0];
        expect(treeProps.files).toEqual([
          { path: "app/Dashboard.tsx", fileId: "f1", status: " M", recordedKind: "edited" },
          { path: "app/new-file.ts", fileId: null, status: "??", gitObserved: "uncommitted", gitChange: null },
        ]);
        expect(treeProps.elsewhere).toEqual([]);
      });

      it("ignores gitObservedFiles when null, matching prior behavior", () => {
        useSessionDomain.mockReturnValue(result(domainWithFiles({ gitObservedFiles: null })));
        renderTab({ sessionId: SESSION_ID, historical: false });

        const treeProps = FileTreeMock.mock.calls.at(-1)![0];
        expect(treeProps.files).toEqual([{ path: "app/Dashboard.tsx", fileId: "f1", status: " M", recordedKind: "edited" }]);
        expect(treeProps.elsewhere).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
      });

      it("keeps Git-observed rows on a historical session with a recorded snapshot", () => {
        useSessionDomain.mockReturnValue(result(domainWithFiles({
          repository: repository({
            historical: true,
            files: [
              { status: " M", path: "app/Dashboard.tsx" },
              { status: "??", path: "app/new-file.ts" },
            ],
          }),
          recordedAt: "2026-09-21T09:00:05.000Z",
          gitObservedFiles: { files: [{ path: "app/committed-only.ts", source: "committed", change: "added" }], truncated: false },
        })));
        renderTab({ sessionId: SESSION_ID, historical: true });

        const segment = screen.getByRole("group", { name: "File segment" });
        expect(within(segment).getByRole("button", { name: "Touched here 2" })).toBeInTheDocument();
        const treeProps = FileTreeMock.mock.calls.at(-1)![0];
        expect(treeProps.files).toEqual(expect.arrayContaining([
          { path: "app/committed-only.ts", fileId: null, status: null, gitObserved: "committed", gitChange: "added" },
        ]));
      });
    });
  });
});
