"use client";

// Repository page Files tab (F20): search, "With session history only" and "Include historical
// files" toggles, and the shared FileTree / FileHistoryPanel pair in repository scope. See
// runs/2026-09-22-ia-session-5/3-file-history/artifacts/plan.md ("implement-tabs") and
// design-contract.md F17-F22.
import { useState } from "react";
import type { FileHistoryReadiness, RepositoryFileEntry } from "../../../shared/repository-files-contract";
import { useFileHistory, useRepositoryFiles, type FileHistoryTarget } from "../../repository-files-store";
import { FileHistoryPanel } from "./FileHistoryPanel";
import { FileTree, type FileTreeFile } from "./FileTree";

function toFileTreeFile(entry: RepositoryFileEntry): FileTreeFile {
  return { path: entry.path, fileId: entry.fileId, sessionCount: entry.sessionCount, muted: entry.sessionCount === 0 || entry.deleted };
}

/** Selection by path; prefers the file's own opaque identity once the listing has resolved it,
 * matching the session-side rule (see app/components/dashboard/repository-files-view.ts). */
function resolveTarget(path: string | null, files: RepositoryFileEntry[]): FileHistoryTarget | null {
  if (!path) return null;
  const entry = files.find((file) => file.path === path);
  return entry ? { fileId: entry.fileId } : { path };
}

function treeEmptyText(readiness: FileHistoryReadiness): string {
  if (readiness === "unavailable") return "File history is unavailable.";
  if (readiness === "rebuilding") return "File history is rebuilding.";
  return "No files match this filter.";
}

export function RepositoryFilesTab({ repositoryId, repositoryLabel, path, onSelectPath }: {
  repositoryId: string;
  repositoryLabel: string;
  /** Selected repository-relative path; null when nothing is selected yet. */
  path: string | null;
  onSelectPath: (path: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [historyOnly, setHistoryOnly] = useState(false);
  const [includeHistorical, setIncludeHistorical] = useState(false);
  const filesResponse = useRepositoryFiles(repositoryId);
  const readiness = filesResponse?.readiness ?? "loading";
  const allFiles = filesResponse?.files ?? [];
  const visible = allFiles.filter((entry) => (!historyOnly || entry.sessionCount > 0) && (includeHistorical || !entry.deleted));
  const query = search.trim().toLowerCase();
  const filtered = query ? visible.filter((entry) => entry.path.toLowerCase().includes(query)) : visible;
  const folderSource = (includeHistorical ? filesResponse?.historicalFolders : filesResponse?.folders) ?? [];
  const folderCounts = new Map(folderSource.map((folder) => [folder.path, folder.sessionCount]));
  const target = resolveTarget(path, allFiles);
  const history = useFileHistory(repositoryId, target);

  return <div className="repositoryFilesTab">
    <div className="repositoryFilesTabToolbar">
      <input
        type="search"
        className="repositoryFilesTabSearch"
        aria-label={`Find a file anywhere in ${repositoryLabel}`}
        placeholder={`Find a file anywhere in ${repositoryLabel}`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="repositoryFilesTabToggles">
        <button type="button" className="commandSecondaryAction" aria-pressed={historyOnly} onClick={() => setHistoryOnly((value) => !value)}>With session history only</button>
        <button type="button" className="commandSecondaryAction" aria-pressed={includeHistorical} onClick={() => setIncludeHistorical((value) => !value)}>Include historical files</button>
      </div>
      <span className="repositoryFilesTabCaption">Counts are recorded sessions per file</span>
    </div>
    <div className="panel repositoryFilesTabBody">
      <FileTree
        scope="repository"
        rootLabel={repositoryLabel}
        files={filtered.map(toFileTreeFile)}
        folderCounts={folderCounts}
        selectedPath={path}
        onSelect={(file) => onSelectPath(file.path)}
        expandAll={query.length > 0}
        emptyText={treeEmptyText(readiness)}
        className="repositoryFilesTabTree"
      />
      <FileHistoryPanel
        side="repository"
        repositoryId={repositoryId}
        repositoryLabel={repositoryLabel}
        path={path}
        // Repository scope has no working-tree status without a new fetch (plan, implement-tabs).
        workingTreeStatus={null}
        history={history}
        className="repositoryFilesTabPanel"
      />
    </div>
  </div>;
}
