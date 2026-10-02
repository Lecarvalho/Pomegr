/**
 * Pure helpers for the session Repository tab's file segments (Touched here / Uncommitted /
 * Changed elsewhere). Kept out of RepositoryTab.tsx so that file stays focused on rendering; see
 * runs/2026-09-22-ia-session-5/3-file-history/artifacts/plan.md ("implement-tabs").
 */
import type { SessionTouchedFile, SessionTouchedFiles } from "../../../shared/session-domain-contract";
import type { FileTreeFile } from "../repositories/FileTree";

export type RepositoryTabFilesSegment = "touched" | "uncommitted" | "elsewhere";

export const REPOSITORY_TAB_FILES_SEGMENTS: ReadonlyArray<{ id: RepositoryTabFilesSegment; label: string }> = [
  { id: "touched", label: "Touched here" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "elsewhere", label: "Changed elsewhere" },
];

type WorkingTreeFile = { status: string; path: string };

export type RepositoryTabFilesSegments = {
  touched: FileTreeFile[];
  /** Uncommitted files this session did not touch; the F4 group under the "Touched here" tree. */
  touchedElsewhere: FileTreeFile[];
  /** Uncommitted files that are also in Touched here; never overlaps `elsewhere`. */
  uncommitted: FileTreeFile[];
  /** Same untouched set as `touchedElsewhere`, shown as its own segment. */
  elsewhere: FileTreeFile[];
};

/** Builds the three segments from the monitor's finished Touched here list and the working-tree
 * status. A recorded entry is a plain recorded row; a committed entry (a path the session's own
 * commits changed that no tool touched) carries the quiet glyph and is removed from Changed
 * elsewhere, so a path shows once. */
export function buildRepositoryTabFilesSegments(touchedFiles: SessionTouchedFile[], workingTreeFiles: WorkingTreeFile[]): RepositoryTabFilesSegments {
  const workingTreeByPath = new Map(workingTreeFiles.map((file) => [file.path, file.status]));
  const touched: FileTreeFile[] = touchedFiles.map((file) => ({
    path: file.path,
    fileId: file.source === "recorded" ? file.fileId : null,
    status: workingTreeByPath.get(file.path) ?? null,
    ...(file.source === "recorded" ? { recordedKind: file.kind } : { gitObserved: file.source, gitChange: file.change }),
  }));
  const touchedFileIds = new Map(touched.map((file) => [file.path, file.fileId]));
  const untouched: FileTreeFile[] = workingTreeFiles
    .filter((file) => !touchedFileIds.has(file.path))
    .map((file) => ({ path: file.path, fileId: null, status: file.status }));
  // Uncommitted and Changed elsewhere partition the working tree: a path in Touched here stays
  // under Uncommitted, every other path under Changed elsewhere, so no file is in both.
  const uncommitted: FileTreeFile[] = workingTreeFiles
    .filter((file) => touchedFileIds.has(file.path))
    .map((file) => ({ path: file.path, fileId: touchedFileIds.get(file.path) ?? null, status: file.status }));
  return { touched, touchedElsewhere: untouched, uncommitted, elsewhere: untouched };
}

export function segmentCount(segments: RepositoryTabFilesSegments, segment: RepositoryTabFilesSegment): number {
  return segment === "touched" ? segments.touched.length : segment === "uncommitted" ? segments.uncommitted.length : segments.elsewhere.length;
}

/** The segment a deep-linked or freshly selected path is found in; "touched" when it is nowhere
 * (also the reasonable default before any data has loaded). */
export function bestRepositoryTabFilesSegment(path: string | null, segments: RepositoryTabFilesSegments): RepositoryTabFilesSegment {
  if (path && segments.touched.some((file) => file.path === path)) return "touched";
  if (path && segments.elsewhere.some((file) => file.path === path)) return "elsewhere";
  return "touched";
}

export function filterFilesByPath(files: FileTreeFile[], query: string): FileTreeFile[] {
  const needle = query.trim().toLowerCase();
  return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
}

/** null signals the loading skeleton (see RepositoryTab.tsx); every other readiness has fixed copy. */
export function touchedSegmentEmptyText(readiness: SessionTouchedFiles["readiness"]): string | null {
  if (readiness === "loading") return null;
  if (readiness === "unavailable") return "File history is unavailable.";
  if (readiness === "rebuilding") return "File history is rebuilding.";
  return "No files touched in this session yet.";
}

export function uncommittedSegmentEmptyText(historical: boolean): string {
  return historical ? "No files touched here were recorded as uncommitted." : "No files touched here are uncommitted.";
}

export const ELSEWHERE_SEGMENT_EMPTY_TEXT = "No uncommitted files outside those touched in this session.";
