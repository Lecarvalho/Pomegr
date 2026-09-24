import { useMemo, useState, type CSSProperties } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import { DottedInfoPopover } from "../DottedInfoPopover";
import {
  buildFileTree,
  defaultOpenFolders,
  fileStatus,
  recordedKindStatus,
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

/** Editor-style single-letter working-tree status, right-aligned at the end of the row. With no
 * working-tree status, falls back to the session's recorded kind as a neutral C or M. */
function FileTreeStatusLetter({ status, recordedKind }: { status: string | null | undefined; recordedKind: FileTreeFile["recordedKind"] }) {
  const info = fileStatus(status);
  if (!info) {
    const recorded = recordedKindStatus(recordedKind);
    return recorded && <span className="fileTreeStatusLetter" role="img" aria-label={recorded.label} title={recorded.label}>{recorded.letter}</span>;
  }
  return <span className={`fileTreeStatusLetter${info.tone ? ` ${info.tone}` : ""}`} role="img" aria-label={info.label} title={info.label}>{info.letter}</span>;
}

const GIT_OBSERVED_LABEL: Record<"committed" | "uncommitted", string> = {
  committed: "Seen in Git during this session (committed) - not a recorded tool edit",
  uncommitted: "Seen in Git during this session (uncommitted) - not a recorded tool edit",
};

/** Quiet glyph-only marker (never a chip, never amber) for a row Git observed during the session
 * window but no recorded tool ever touched. Shown on historical rows too; see DESIGN.md. */
function FileTreeGitObservedGlyph({ source }: { source: "committed" | "uncommitted" }) {
  const label = GIT_OBSERVED_LABEL[source];
  return <span className="fileTreeGitObservedGlyph" role="img" aria-label={label} title={label}>
    <CommandIcon name="git" size="small" />
  </span>;
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
    <span className="fileTreeFileName">{name}</span>
    {file.gitObserved && <FileTreeGitObservedGlyph source={file.gitObserved} />}
    {scope === "session" && <FileTreeStatusLetter status={file.status} recordedKind={file.recordedKind} />}
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
  const hasGitObserved = scope === "session" && files.some((file) => file.gitObserved);

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
      {scope === "session"
        ? <>
            <span>Status from the working tree · select a file for its history</span>
            {hasGitObserved && <DottedInfoPopover ariaLabel="How Git-observed rows are chosen" className="fileTreeFooterInfo" content="Rows with the Git glyph come from commits and working-tree changes during the session window. They may include other people's or tools' changes and have no agent or request.">How to read this</DottedInfoPopover>}
          </>
        : "Folders roll up distinct sessions"}
    </div>
  </div>;
}
