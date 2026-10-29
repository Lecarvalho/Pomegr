import type { RepositoryUnavailableReason } from "../../../shared/session-domain-contract";

// One wording for each reason, shared by the session header, the Overview tile, and the Repository tab.
const LABELS: Record<RepositoryUnavailableReason, string> = {
  branch_changed: "Branch changed",
  not_repository: "Not a Git repository",
  timeout: "Git timed out",
  git_missing: "Git not found",
  refused: "Git refused the folder",
  failed: "Git read failed",
};

const SENTENCES: Record<RepositoryUnavailableReason, string> = {
  branch_changed: "The working tree is no longer on this session's branch.",
  not_repository: "Git reports that this session's folder is not a Git repository.",
  timeout: "Git did not answer in time for this session's folder.",
  git_missing: "Pomegr could not find Git on this computer.",
  refused: "Git refused this session's folder as unsafe (safe.directory).",
  failed: "Pomegr could not read Git state for this session's folder.",
};

/** The short label for a chip or a tile line. */
export function repositoryUnavailableLabel(reason: RepositoryUnavailableReason): string {
  return LABELS[reason];
}

/** The Repository tab's sentence for why no Git state is shown. */
export function repositoryUnavailableSentence(reason: RepositoryUnavailableReason | null): string {
  return `${reason ? SENTENCES[reason] : "Git state is unavailable for this session."} Branch comparison, pull requests, and uncommitted files are unavailable.`;
}

/** A reason the session header shows as a chip: a Git read's answer, not a branch change, which the Repository tab explains. */
export function headerRepositoryReason(reason: RepositoryUnavailableReason | null | undefined): RepositoryUnavailableReason | null {
  return reason && reason !== "branch_changed" ? reason : null;
}
