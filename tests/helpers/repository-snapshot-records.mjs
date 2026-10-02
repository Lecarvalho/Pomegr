// Synthetic repository-snapshot records for the repository snapshot and session-commit tests:
// the current (version 6) shape and the exact shapes earlier builds wrote.
export const REPOSITORY_ID = "repo-0123456789abcdef01234567";

export function validSnapshot(overrides = {}) {
  return {
    version: 6,
    branch: "feat/example",
    isMain: false,
    files: [{ status: " M", path: "app/file.ts" }],
    comparison: { branch: "origin/main", kind: "base", ahead: 2, behind: 0, integrated: false },
    comparisonCheckedAt: "2026-09-20T12:00:00.000Z",
    pullRequests: { checkedAt: "2026-09-20T12:00:00.000Z", items: [pullRequestItem()] },
    commitsInSession: 3,
    checkedAt: "2026-09-20T12:00:05.000Z",
    repositoryId: null,
    commitTimesInWindow: null,
    sessionCommitPaths: null,
    sessionCommitChanges: null,
    sessionCommitsTruncated: false,
    ...overrides,
  };
}

// The exact key set each earlier version wrote (version 1 predates the Git-observed lists), so the
// upgrade tests build records the way an older build did.
const CORE_KEYS = ["version", "branch", "isMain", "files", "comparison", "comparisonCheckedAt", "pullRequests", "commitsInSession", "checkedAt"];
const LEGACY_KEYS = { 1: CORE_KEYS };
LEGACY_KEYS[2] = [...CORE_KEYS, "dirtyAtFirstCheck", "becameDirty", "committedInWindow", "gitObservedTruncated"];
LEGACY_KEYS[3] = [...LEGACY_KEYS[2], "committedChanges"];
LEGACY_KEYS[4] = [...LEGACY_KEYS[3], "repositoryId"];
LEGACY_KEYS[5] = [...LEGACY_KEYS[4], "commitTimesInWindow"];
export const LEGACY_VALUES = {
  dirtyAtFirstCheck: ["app/old-dirty.ts"],
  becameDirty: ["app/old-later.ts"],
  committedInWindow: ["app/old-commit.ts"],
  committedChanges: ["added"],
  gitObservedTruncated: false,
  repositoryId: REPOSITORY_ID,
  commitTimesInWindow: ["2026-09-20T11:30:00.000Z"],
};
export function legacySnapshot(version, overrides = {}) {
  const everything = { ...validSnapshot(), ...LEGACY_VALUES, ...overrides, version };
  return Object.fromEntries(LEGACY_KEYS[version].map((key) => [key, everything[key]]));
}

export function pullRequestItem(overrides = {}) {
  return {
    host: "github",
    repository: "Lecarvalho/pomegr",
    number: 24,
    title: "Draft PR",
    url: "https://github.com/Lecarvalho/pomegr/pull/24",
    state: "open",
    draft: true,
    headBranch: "feat/example",
    baseBranch: "main",
    additions: 842,
    deletions: 1117,
    updatedAt: "2026-09-20T11:00:00.000Z",
    association: "session",
    ...overrides,
  };
}
