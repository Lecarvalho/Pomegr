import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest, SessionSummary } from "../../shared/monitor-contract";
import type { RepositoryDomain, SessionTouchedFile } from "../../shared/session-domain-contract";
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
type RecordedFile = Extract<SessionTouchedFile, { source: "recorded" }>;
type CommittedFile = Extract<SessionTouchedFile, { source: "committed" }>;

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
    unavailableReason: null,
    pullRequests: { status: "ready", checkedAt: "2026-09-22T12:00:00.000Z", items: [draftPullRequest] },
    recordedAt: null,
    commitsInSession: 2,
    gitTasks: { total: 9, failed: 0 },
    touchedFiles: { readiness: "unavailable", files: [], truncated: false },
    ...overrides,
  } as RepositoryDomain;
}

function recordedFile(overrides: Partial<RecordedFile> = {}): RecordedFile {
  return { source: "recorded", fileId: "f1", path: "app/Dashboard.tsx", kind: "edited", changeCount: 2, lastObservedAt: "2026-09-22T12:00:00.000Z", agents: [], ...overrides };
}

function committedFile(path: string, change: CommittedFile["change"] = "added"): CommittedFile {
  return { path, source: "committed", change };
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

  it("reads the live repository domain and never lists commits on the session page", () => {
    useSessionDomain.mockReturnValue(result(domain()));
    renderTab({ sessionId: SESSION_ID, historical: false });

    expect(useSessionDomain).toHaveBeenCalledWith({ sessionId: SESSION_ID, domain: "repository" }, { historical: false, enabled: true });
    expect(screen.queryByText("Should never render on the session page")).not.toBeInTheDocument();
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

  it("keeps recorded file changes for a historical session with no snapshot, without claiming Git state", () => {
    useSessionDomain.mockReturnValue(result(domain({
      repository: repository({ historical: true, comparison: null, remote: { status: "unavailable", checkedAt: null } }),
      recordedAt: null,
      pullRequests: { status: "unavailable", checkedAt: null, items: [] },
      commitsInSession: null,
      touchedFiles: { readiness: "ready", files: [recordedFile()], truncated: false },
    })));
    renderTab({ sessionId: SESSION_ID, historical: true });

    expect(screen.getByText("No saved Git snapshot for this session. Branch comparison, pull requests, and uncommitted files are unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
    expect(screen.queryByText("Remote comparison unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Recorded at the session's last live check")).not.toBeInTheDocument();
    // Recorded changes come from the file-change index, so they list without a snapshot.
    expect(screen.getByRole("searchbox", { name: "Find a file touched in this session" })).toBeInTheDocument();
    expect(FileTreeMock.mock.calls.at(-1)![0].files).toEqual([{ path: "app/Dashboard.tsx", fileId: "f1", status: null, recordedKind: "edited" }]);
    // Uncommitted and Changed elsewhere need the snapshot; a zero count would read as "none".
    expect(screen.queryByRole("group", { name: "File segment" })).not.toBeInTheDocument();
  });

  it("lists touched files when the working tree left the session's branch, without claiming Git state", () => {
    const unavailable = repository({ available: false, branch: "Not a Git repository", comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } });
    useSessionDomain.mockReturnValue(result(domain({
      readiness: "unavailable",
      repository: unavailable,
      unavailableReason: "branch_changed",
      pullRequests: { status: "unavailable", checkedAt: null, items: [] },
      commitsInSession: null,
      touchedFiles: { readiness: "ready", files: [recordedFile(), committedFile("app/observed.ts")], truncated: false },
    })));
    const { rerender } = renderTab({ sessionId: SESSION_ID, historical: false });

    expect(screen.getByText(/The working tree is no longer on this session's branch\./)).toBeInTheDocument();
    expect(screen.queryByText("Not a Git repository")).not.toBeInTheDocument();
    expect(screen.queryByText("No Git repository detected for this session.")).not.toBeInTheDocument();
    expect(FileTreeMock.mock.calls.at(-1)![0].files.map((file) => file.path)).toEqual(["app/Dashboard.tsx", "app/observed.ts"]);
    expect(screen.queryByRole("group", { name: "File segment" })).not.toBeInTheDocument();

    // An unrecognized reason still lists the files, under neutral copy.
    useSessionDomain.mockReturnValue(result(domain({ repository: unavailable, unavailableReason: null, touchedFiles: { readiness: "ready", files: [recordedFile()], truncated: false } })));
    rerender(<LiveClockProvider running={false}><SessionCatalogProvider sessions={[]}><RepositoryTab sessionId={SESSION_ID} historical={false} /></SessionCatalogProvider></LiveClockProvider>);
    expect(screen.getByText(/Git state is unavailable for this session\./)).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Find a file touched in this session" })).toBeInTheDocument();

    // No linked repository: nothing to list.
    FileTreeMock.mockReset();
    useSessionDomain.mockReturnValue(result(domain({ repository: unavailable, repositoryId: null })));
    rerender(<LiveClockProvider running={false}><SessionCatalogProvider sessions={[]}><RepositoryTab sessionId={SESSION_ID} historical={false} /></SessionCatalogProvider></LiveClockProvider>);
    expect(screen.getByText("No Git repository detected for this session.")).toBeInTheDocument();
    expect(FileTreeMock).not.toHaveBeenCalled();
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

  describe("files body (F17/F18)", () => {
    function domainWithFiles(overrides: Record<string, unknown> = {}) {
      return domain({
        repository: repository({
          files: [
            { status: " M", path: "app/Dashboard.tsx" }, // touched, currently modified
            { status: "??", path: "app/new-file.ts" }, // uncommitted, not touched this session
          ],
        }),
        touchedFiles: { readiness: "ready", files: [recordedFile()], truncated: false },
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
      expect(within(segment).getByRole("button", { name: "Uncommitted 1" })).toHaveAttribute("aria-pressed", "false");
      expect(within(segment).getByRole("button", { name: "Changed elsewhere 1" })).toHaveAttribute("aria-pressed", "false");

      const treeProps = FileTreeMock.mock.calls.at(-1)![0];
      expect(treeProps.scope).toBe("session");
      expect(treeProps.files).toEqual([{ path: "app/Dashboard.tsx", fileId: "f1", status: " M", recordedKind: "edited" }]);
      expect(treeProps.elsewhere).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
    });

    it("switches to Uncommitted and Changed elsewhere on click, changing the files passed to FileTree", async () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false });

      await userEvent.click(screen.getByRole("button", { name: "Uncommitted 1" }));
      let treeProps = FileTreeMock.mock.calls.at(-1)![0];
      const uncommittedFiles = treeProps.files;
      expect(uncommittedFiles).toEqual([{ path: "app/Dashboard.tsx", fileId: "f1", status: " M" }]);
      expect(treeProps.elsewhere).toBeUndefined();

      await userEvent.click(screen.getByRole("button", { name: "Changed elsewhere 1" }));
      treeProps = FileTreeMock.mock.calls.at(-1)![0];
      expect(treeProps.files).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
      expect(treeProps.elsewhere).toBeUndefined();
      // A working-tree file is listed in exactly one of the two segments.
      const elsewherePaths = new Set(treeProps.files.map((file) => file.path));
      expect(uncommittedFiles.filter((file) => elsewherePaths.has(file.path))).toEqual([]);
    });

    it("opens a deep-linked untouched uncommitted path in Changed elsewhere", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false, selectedPath: "app/new-file.ts" });

      expect(screen.getByRole("button", { name: "Changed elsewhere 1" })).toHaveAttribute("aria-pressed", "true");
      expect(FileTreeMock.mock.calls.at(-1)![0].files).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
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
      expect(panelProps.file).toEqual(recordedFile());
      expect(panelProps.readiness).toBe("ready");
    });

    it("empties the panel while the tree does not list the selected file", async () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles()));
      renderTab({ sessionId: SESSION_ID, historical: false, selectedPath: "app/Dashboard.tsx" });
      const shown = () => {
        const panelProps = SessionFilePanelMock.mock.calls.at(-1)![0];
        return [FileTreeMock.mock.calls.at(-1)![0].selectedPath, panelProps.path, panelProps.file?.source === "recorded" ? panelProps.file.fileId : null];
      };

      // Changed elsewhere holds only files this session did not touch.
      await userEvent.click(screen.getByRole("button", { name: "Changed elsewhere 1" }));
      expect(shown()).toEqual([null, null, null]);

      await userEvent.click(screen.getByRole("button", { name: "Uncommitted 1" }));
      expect(shown()).toEqual(["app/Dashboard.tsx", "app/Dashboard.tsx", "f1"]);

      // A search that drops the row hides it the same way.
      await userEvent.type(screen.getByRole("searchbox", { name: "Find a file touched in this session" }), "new-file");
      expect(shown()).toEqual([null, null, null]);
    });

    it("passes the committed entry when no tool recorded the selected file", () => {
      const committedOnly = committedFile("app/committed-only.ts");
      useSessionDomain.mockReturnValue(result(domainWithFiles({ touchedFiles: { readiness: "ready", files: [recordedFile(), committedOnly], truncated: false } })));
      renderTab({ sessionId: SESSION_ID, historical: false, selectedPath: "app/committed-only.ts" });
      const panelProps = SessionFilePanelMock.mock.calls.at(-1)![0];
      expect(panelProps.file).toEqual(committedOnly);
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
      useSessionDomain.mockReturnValue(result(domainWithFiles({ touchedFiles: { readiness: "loading", files: [], truncated: false } })));
      FileTreeMock.mockClear();
      renderTab({ sessionId: SESSION_ID, historical: false });
      expect(screen.getByLabelText("Loading file history")).toBeInTheDocument();
      expect(FileTreeMock).not.toHaveBeenCalled();
    });

    it("gives an unavailable/rebuilding empty text without a skeleton once file history has answered", () => {
      useSessionDomain.mockReturnValue(result(domainWithFiles({ touchedFiles: { readiness: "unavailable", files: [], truncated: false } })));
      renderTab({ sessionId: SESSION_ID, historical: false });
      expect(FileTreeMock.mock.calls.at(-1)![0].emptyText).toBe("File history is unavailable.");

      useSessionDomain.mockReturnValue(result(domainWithFiles({ touchedFiles: { readiness: "rebuilding", files: [], truncated: false } })));
      renderTab({ sessionId: SESSION_ID, historical: false });
      expect(FileTreeMock.mock.calls.at(-1)![0].emptyText).toBe("File history is rebuilding.");
    });

    describe("Committed files", () => {
      it("lists a path this session committed in Touched here, tags it, and removes it from Changed elsewhere/counts, leaving an already-recorded path a plain recorded row", () => {
        useSessionDomain.mockReturnValue(result(domainWithFiles({
          repository: repository({
            files: [
              { status: " M", path: "app/Dashboard.tsx" }, // touched, currently modified
              { status: " M", path: "app/later-edit.ts" }, // committed by this session, edited again since
              { status: "??", path: "app/new-file.ts" }, // uncommitted, not committed by this session
            ],
          }),
          touchedFiles: {
            readiness: "ready",
            files: [
              recordedFile(), // recorded and also committed: the monitor lists it once, as a plain recorded row
              committedFile("app/committed-only.ts", "added"), // not recorded and clean; gains the glyph
              committedFile("app/later-edit.ts", "modified"), // not recorded; gains the glyph, moves out of elsewhere
            ],
            truncated: false,
          },
        })));
        renderTab({ sessionId: SESSION_ID, historical: false });

        const segment = screen.getByRole("group", { name: "File segment" });
        expect(within(segment).getByRole("button", { name: "Touched here 3" })).toBeInTheDocument();
        expect(within(segment).getByRole("button", { name: "Uncommitted 2" })).toBeInTheDocument();
        expect(within(segment).getByRole("button", { name: "Changed elsewhere 1" })).toBeInTheDocument();

        const treeProps = FileTreeMock.mock.calls.at(-1)![0];
        expect(treeProps.files).toEqual([
          { path: "app/Dashboard.tsx", fileId: "f1", status: " M", recordedKind: "edited" },
          { path: "app/committed-only.ts", fileId: null, status: null, gitObserved: "committed", gitChange: "added" },
          { path: "app/later-edit.ts", fileId: null, status: " M", gitObserved: "committed", gitChange: "modified" },
        ]);
        expect(treeProps.elsewhere).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
      });

      it("lists no committed row when the touched list holds no committed entry, matching prior behavior", () => {
        useSessionDomain.mockReturnValue(result(domainWithFiles({ touchedFiles: { readiness: "ready", files: [recordedFile()], truncated: false } })));
        renderTab({ sessionId: SESSION_ID, historical: false });

        const treeProps = FileTreeMock.mock.calls.at(-1)![0];
        expect(treeProps.files).toEqual([{ path: "app/Dashboard.tsx", fileId: "f1", status: " M", recordedKind: "edited" }]);
        expect(treeProps.elsewhere).toEqual([{ path: "app/new-file.ts", fileId: null, status: "??" }]);
      });

      it("keeps committed rows on a historical session with a recorded snapshot", () => {
        useSessionDomain.mockReturnValue(result(domainWithFiles({
          repository: repository({
            historical: true,
            files: [
              { status: " M", path: "app/Dashboard.tsx" },
              { status: "??", path: "app/new-file.ts" },
            ],
          }),
          recordedAt: "2026-09-21T09:00:05.000Z",
          touchedFiles: { readiness: "ready", files: [recordedFile(), committedFile("app/committed-only.ts")], truncated: false },
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
