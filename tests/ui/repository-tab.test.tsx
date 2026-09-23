import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest } from "../../shared/monitor-contract";
import type { RepositoryDomain } from "../../shared/session-domain-contract";
import { RepositoryTab, type RepositoryTabProps } from "../../app/components/dashboard/RepositoryTab";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";

function renderTab(props: RepositoryTabProps) {
  return render(<LiveClockProvider running={false}><RepositoryTab {...props} /></LiveClockProvider>);
}

const { useSessionDomain } = vi.hoisted(() => ({ useSessionDomain: vi.fn() }));
vi.mock("../../app/session-domain-store", () => ({ useSessionDomain }));

const SESSION_ID = "claude:repo-tab";
const REPOSITORY_ID = "repo-0123456789abcdef01234567";

type Repository = NonNullable<RepositoryDomain["repository"]>;

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
    fileHistory: { readiness: "unavailable", items: [] },
    ...overrides,
  } as RepositoryDomain;
}

function result(data: RepositoryDomain | null, error: string | null = null, unavailable = false) {
  return { data, error, fetching: false, connected: true, unavailable, revalidate: vi.fn() };
}

describe("RepositoryTab", () => {
  beforeEach(() => { useSessionDomain.mockReset(); });

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

  it("shows the recorded files and the recorded-snapshot caption for a historical session with a snapshot", () => {
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
    expect(screen.getByText("Dashboard.tsx")).toBeInTheDocument();
    expect(within(screen.getByText("Uncommitted files").closest("section")!).getByText("MOD")).toBeInTheDocument();
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
    expect(screen.queryByText("Uncommitted files")).not.toBeInTheDocument();
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
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
    rerender(<LiveClockProvider running={false}><RepositoryTab sessionId={SESSION_ID} historical={false} /></LiveClockProvider>);
    expect(screen.queryByRole("link", { name: /Git tab on repository page/ })).not.toBeInTheDocument();
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
});
