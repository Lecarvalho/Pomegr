/**
 * Pure helpers for the session Repository tab's file segments (Touched here / Uncommitted /
 * Changed elsewhere). Kept out of RepositoryTab.tsx so that file stays focused on rendering; see
 * runs/2026-09-22-ia-session-5/3-file-history/artifacts/plan.md ("implement-tabs").
 */
import type { FileHistoryTarget } from "../../repository-files-store";
import type { RepositoryDomain } from "../../../shared/session-domain-contract";
import type { FileTreeFile } from "../repositories/FileTree";

export type RepositoryTabFilesSegment = "touched" | "uncommitted" | "elsewhere";

export const REPOSITORY_TAB_FILES_SEGMENTS: ReadonlyArray<{ id: RepositoryTabFilesSegment; label: string }> = [
  { id: "touched", label: "Touched here" },
  { id: "uncommitted", label: "Uncommitted" },
  { id: "elsewhere", label: "Changed elsewhere" },
];

type WorkingTreeFile = { status: string; path: string };
type TouchedFile = RepositoryDomain["fileHistory"]["files"][number];

export type RepositoryTabFilesSegments = {
  touched: FileTreeFile[];
  /** Uncommitted files this session did not touch; the F4 group under the "Touched here" tree. */
  touchedElsewhere: FileTreeFile[];
  uncommitted: FileTreeFile[];
  /** Same untouched set as `touchedElsewhere`, shown as its own segment. */
  elsewhere: FileTreeFile[];
};

/** Builds the three segments from the session's touched-file history and its working-tree status. */
export function buildRepositoryTabFilesSegments(touchedFiles: TouchedFile[], workingTreeFiles: WorkingTreeFile[]): RepositoryTabFilesSegments {
  const workingTreeByPath = new Map(workingTreeFiles.map((file) => [file.path, file.status]));
  const touchedPaths = new Set(touchedFiles.map((file) => file.path));
  const touched: FileTreeFile[] = touchedFiles.map((file) => ({
    path: file.path,
    fileId: file.fileId,
    status: workingTreeByPath.get(file.path) ?? null,
  }));
  const untouched: FileTreeFile[] = workingTreeFiles
    .filter((file) => !touchedPaths.has(file.path))
    .map((file) => ({ path: file.path, fileId: null, status: file.status }));
  const uncommitted: FileTreeFile[] = workingTreeFiles.map((file) => ({
    path: file.path,
    fileId: touchedFiles.find((touchedFile) => touchedFile.path === file.path)?.fileId ?? null,
    status: file.status,
  }));
  return { touched, touchedElsewhere: untouched, uncommitted, elsewhere: untouched };
}

export function segmentCount(segments: RepositoryTabFilesSegments, segment: RepositoryTabFilesSegment): number {
  return segment === "touched" ? segments.touched.length : segment === "uncommitted" ? segments.uncommitted.length : segments.elsewhere.length;
}

/** The segment a deep-linked or freshly selected path is found in; "touched" when it is nowhere
 * (also the reasonable default before any data has loaded). */
export function bestRepositoryTabFilesSegment(path: string | null, segments: RepositoryTabFilesSegments): RepositoryTabFilesSegment {
  if (path && segments.touched.some((file) => file.path === path)) return "touched";
  if (path && segments.uncommitted.some((file) => file.path === path)) return "uncommitted";
  return "touched";
}

export function filterFilesByPath(files: FileTreeFile[], query: string): FileTreeFile[] {
  const needle = query.trim().toLowerCase();
  return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
}

/** null signals the loading skeleton (see RepositoryTab.tsx); every other readiness has fixed copy. */
export function touchedSegmentEmptyText(readiness: RepositoryDomain["fileHistory"]["readiness"]): string | null {
  if (readiness === "loading") return null;
  if (readiness === "unavailable") return "File history is unavailable.";
  if (readiness === "rebuilding") return "File history is rebuilding.";
  return "No files touched in this session yet.";
}

export function uncommittedSegmentEmptyText(historical: boolean): string {
  return historical ? "No uncommitted files were recorded." : "No uncommitted files.";
}

export const ELSEWHERE_SEGMENT_EMPTY_TEXT = "No uncommitted files outside those touched in this session.";

/** Prefers the touched file's own recorded identity; falls back to a path lookup so an untouched
 * or not-yet-loaded selection still resolves (see plan: "history via useFileHistory(repositoryId,
 * fileId ? {fileId} : {path})"). */
export function resolveRepositoryTabFileTarget(selectedPath: string | null, touchedFiles: TouchedFile[]): FileHistoryTarget | null {
  if (!selectedPath) return null;
  const touched = touchedFiles.find((file) => file.path === selectedPath);
  return touched ? { fileId: touched.fileId } : { path: selectedPath };
}
