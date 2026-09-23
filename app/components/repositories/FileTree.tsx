import { useMemo, useState, type CSSProperties } from "react";
import {
  buildFileTree,
  defaultOpenFolders,
  fileStatusChip,
  sortByPath,
  visibleFileTreeRows,
  type FileTreeFile,
} from "./file-tree-model";

export type { FileTreeFile };

export type FileTreeProps = {
  scope: "session" | "repository";
  rootLabel: string; // repository display name for the header eyebrow
  files: FileTreeFile[];
  /** Session scope only: uncommitted files the session did not touch ("Changed elsewhere"). */
  elsewhere?: FileTreeFile[];
  /** Repository scope only: distinct-session rollup per folder path. */
  folderCounts?: ReadonlyMap<string, number>;
  selectedPath: string | null;
  onSelect: (file: FileTreeFile) => void;
  /** Expand every folder (used while a search query is active). */
  expandAll?: boolean;
  emptyText: string;
  className?: string;
};

function depthStyle(depth: number): CSSProperties {
  return { "--tree-depth": depth } as CSSProperties;
}

function TreeChevron() {
  return <svg className="fileTreeChevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>;
}

function FileTreeStatusChip({ status }: { status: string | null | undefined }) {
  const chip = fileStatusChip(status);
  if (!chip) return null;
  return <span className={`commandChip small${chip.tone ? ` ${chip.tone}` : ""}`}>{chip.label}</span>;
}

function FileTreeFileRow({ scope, depth, name, file, selected, onSelect }: {
  scope: "session" | "repository";
  depth: number;
  name: string;
  file: FileTreeFile;
  selected: boolean;
  onSelect: (file: FileTreeFile) => void;
}) {
  const showCount = scope === "repository" && !file.muted && typeof file.sessionCount === "number" && file.sessionCount > 0;
  return <button
    type="button"
    className={`fileTreeRow fileTreeFileRow${selected ? " isSelected" : ""}${file.muted ? " isMuted" : ""}`}
    style={depthStyle(depth)}
    aria-current={selected ? "true" : undefined}
    onClick={() => onSelect(file)}
  >
    {scope === "session" && <FileTreeStatusChip status={file.status} />}
    <span className="fileTreeFileName">{name}</span>
    {showCount && <span className="fileTreeCount">{file.sessionCount}</span>}
  </button>;
}

export function FileTree({ scope, rootLabel, files, elsewhere = [], folderCounts, selectedPath, onSelect, expandAll = false, emptyText, className = "" }: FileTreeProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const defaultOpen = useMemo(() => defaultOpenFolders(tree, selectedPath), [tree, selectedPath]);
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});

  const isOpen = (path: string) => (path in overrides ? overrides[path] : defaultOpen.has(path));
  const toggleFolder = (path: string) => setOverrides((current) => ({ ...current, [path]: !isOpen(path) }));
  const rows = useMemo(
    () => (expandAll ? visibleFileTreeRows(tree, () => true) : visibleFileTreeRows(tree, isOpen)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isOpen closes over `overrides`, already a dependency
    [tree, overrides, expandAll, defaultOpen],
  );
  const sortedElsewhere = useMemo(() => sortByPath(elsewhere), [elsewhere]);
  const isEmpty = files.length === 0 && sortedElsewhere.length === 0;

  return <div className={`panel fileTree ${className}`.trim()}>
    <div className="fileTreeHeader">
      <span className="fileTreeEyebrow">{rootLabel}</span>
      {scope === "repository" && <span className="fileTreeEyebrow fileTreeEyebrowRight">Sessions</span>}
    </div>
    <div className="fileTreeBody">
      {isEmpty ? <p className="fileTreeEmpty">{emptyText}</p> : <>
        {rows.map((row) => row.kind === "folder"
          ? <button
              key={`folder:${row.node.path}`}
              type="button"
              className="fileTreeRow fileTreeFolderRow"
              style={depthStyle(row.depth)}
              aria-expanded={row.open}
              onClick={() => toggleFolder(row.node.path)}
            >
              <TreeChevron />
              <span className="fileTreeFolderName">{row.node.name}</span>
              {scope === "repository" && folderCounts?.has(row.node.path) && <span className="fileTreeCount">{folderCounts.get(row.node.path)}</span>}
            </button>
          : <FileTreeFileRow
              key={`file:${row.node.path}`}
              scope={scope}
              depth={row.depth}
              name={row.node.name}
              file={row.node.file}
              selected={row.node.file.path === selectedPath}
              onSelect={onSelect}
            />)}
        {scope === "session" && sortedElsewhere.length > 0 && <>
          <div className="fileTreeGroupHeading">Changed elsewhere</div>
          {sortedElsewhere.map((file) => <FileTreeFileRow
            key={`elsewhere:${file.path}`}
            scope="session"
            depth={0}
            name={file.path}
            file={file}
            selected={file.path === selectedPath}
            onSelect={onSelect}
          />)}
        </>}
      </>}
    </div>
    <div className="fileTreeFooter">
      {scope === "session" ? "Status from the working tree · select a file for its history" : "Folders roll up distinct sessions"}
    </div>
  </div>;
}
