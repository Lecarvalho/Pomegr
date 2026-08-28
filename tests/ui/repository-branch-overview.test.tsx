import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RepositoryPanel } from "../../app/components/dashboard/RepositoryPanel";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { repositorySession } from "./dashboard-test-fixtures";

describe("repository branch overview", () => {
  it("shows recent commits and upstream status on the main branch", () => {
    const session = repositorySession({
      available: true,
      branch: "main",
      files: [],
      historical: false,
      isMain: true,
      comparison: { branch: "origin/main", kind: "upstream", ahead: 1, behind: 0, integrated: false },
      commits: [{ hash: "abc1234", subject: "Add commit history", committedAt: "2026-08-09T12:00:00.000Z" }],
      remote: { status: "ready", checkedAt: "2026-08-09T12:01:00.000Z" },
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByRole("region", { name: "Git branch overview" })).toHaveTextContent("RECENT COMMITS");
    expect(screen.getByText("1 commit ahead compared with origin/main")).toBeInTheDocument();
    expect(screen.getByText("Add commit history")).toBeInTheDocument();
    expect(screen.getByText("No local changes.")).toBeInTheDocument();
    expect(screen.queryByText("Working tree clean")).not.toBeInTheDocument();
  });

  it("shows branch-only commits relative to the default branch", () => {
    const session = repositorySession({
      available: true,
      branch: "feature/commits",
      files: [{ status: " M", path: "app/Dashboard.tsx" }],
      historical: false,
      isMain: false,
      comparison: { branch: "origin/main", kind: "base", ahead: 2, behind: 1, integrated: false },
      commits: [{ hash: "def5678", subject: "Consolidate branch state", committedAt: null }],
      remote: { status: "ready", checkedAt: "2026-08-09T12:01:00.000Z" },
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByText("COMMITS SINCE ORIGIN/MAIN")).toBeInTheDocument();
    expect(screen.getByText("2 commits ahead · 1 commit behind relative to origin/main")).toBeInTheDocument();
    expect(screen.getByText("Consolidate branch state")).toBeInTheDocument();
    expect(screen.getByText("Dashboard.tsx")).toBeInTheDocument();
    expect(screen.queryByText("1 uncommitted")).not.toBeInTheDocument();
  });

  it("shows remote progress without using stale comparison data", () => {
    const session = repositorySession({
      available: true,
      branch: "feature/commits",
      files: [],
      historical: false,
      isMain: false,
      comparison: null,
      commits: [],
      remote: { status: "checking", checkedAt: null },
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByText("Checking remote…")).toBeInTheDocument();
    expect(screen.getByText("Checking the remote default branch…")).toBeInTheDocument();
    expect(screen.queryByText(/relative to/)).not.toBeInTheDocument();
  });

  it("labels squash-merged changes as integrated", () => {
    const session = repositorySession({
      available: true,
      branch: "feature/squash-merged",
      files: [],
      historical: false,
      isMain: false,
      comparison: { branch: "origin/main", kind: "base", ahead: 0, behind: 1, integrated: true },
      commits: [],
      remote: { status: "ready", checkedAt: "2026-08-09T12:01:00.000Z" },
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByText("Changes integrated into origin/main")).toBeInTheDocument();
    expect(screen.getByText("UNMERGED BRANCH COMMITS")).toBeInTheDocument();
    expect(screen.getByText("Branch changes are already integrated into origin/main.")).toBeInTheDocument();
    expect(screen.queryByText(/ahead/)).not.toBeInTheDocument();
  });

  it("lets a matching merged pull request replace the integrated comparison badge", () => {
    const session = repositorySession({
      available: true,
      branch: "feature/merged-pr",
      files: [],
      historical: false,
      isMain: false,
      comparison: { branch: "origin/main", kind: "base", ahead: 0, behind: 1, integrated: true },
      commits: [],
      remote: { status: "ready", checkedAt: "2026-08-10T12:01:00.000Z" },
    }, {
      status: "ready",
      checkedAt: "2026-08-10T12:02:00.000Z",
      items: [{
        host: "github",
        repository: "PomegrHQ/pomegr",
        number: 42,
        title: "Merge the completed feature",
        url: "https://github.com/PomegrHQ/pomegr/pull/42",
        state: "merged",
        draft: false,
        headBranch: "feature/merged-pr",
        baseBranch: "main",
        additions: 20,
        deletions: 4,
        updatedAt: "2026-08-10T12:00:00.000Z",
        association: "session",
      }],
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    expect(screen.getByRole("button", { name: "merged PR #42" })).toBeInTheDocument();
    expect(screen.queryByText("Changes integrated into origin/main")).not.toBeInTheDocument();
  });

  it("opens a dismissible pull-request view from the repository header", async () => {
    const user = userEvent.setup();
    const session = repositorySession({
      available: true,
      branch: "feature/pr-drawer",
      files: [],
      historical: false,
      isMain: false,
      comparison: { branch: "origin/main", kind: "base", ahead: 1, behind: 0, integrated: false },
      commits: [],
      remote: { status: "ready", checkedAt: "2026-08-10T12:01:00.000Z" },
    }, {
      status: "ready",
      checkedAt: "2026-08-10T12:02:00.000Z",
      items: [{
        host: "github",
        repository: "PomegrHQ/pomegr",
        number: 42,
        title: "Add session pull-request view",
        url: "https://github.com/PomegrHQ/pomegr/pull/42",
        state: "open",
        draft: false,
        headBranch: "feature/pr-drawer",
        baseBranch: "main",
        additions: 447,
        deletions: 22,
        updatedAt: "2026-08-10T12:00:00.000Z",
        association: "session",
      }],
    });

    render(<LiveClockProvider running={false}><RepositoryPanel session={session} /></LiveClockProvider>);

    await user.click(screen.getByRole("button", { name: "open PR #42" }));
    const dialog = screen.getByRole("dialog", { name: "Pull requests linked to this session" });
    expect(dialog).toHaveTextContent("Add session pull-request view");
    expect(dialog).toHaveTextContent("PomegrHQ/pomegr · #42 · recorded in session");
    expect(dialog).toHaveTextContent("feature/pr-drawer → main");
    expect(dialog).toHaveTextContent("+447");
    expect(dialog).toHaveTextContent("−22");
    expect(screen.getByRole("link", { name: /Add session pull-request view/ })).toHaveAttribute("href", "https://github.com/PomegrHQ/pomegr/pull/42");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Pull requests linked to this session" })).not.toBeInTheDocument();
  });
});
