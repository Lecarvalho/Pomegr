// Pure tree-building helpers for FileTree.tsx. No fetching, no session/monitor imports.
// FileTreeFile lives here (not in FileTree.tsx, which re-exports it) so the model and the
// component do not import each other and create a circular dependency.

/** One file the tree shows. `status` is the git porcelain code (e.g. "M", "A", "??", "D"). */
export type FileTreeFile = {
  path: string; // repository-relative, "/" separated
  fileId: string | null; // null for a working-tree file with no recorded history
  status?: string | null; // session scope: working-tree status chip
  sessionCount?: number | null; // repository scope: distinct recorded sessions
  muted?: boolean; // repository scope: no recorded session history, or deleted
  /** Session scope only: this row is not a recorded tool edit, only seen in Git during the
   *  session window (committed on the live HEAD branch, or turned uncommitted between the
   *  session's first and latest live Git checks). Renders a quiet glyph, never a chip. */
  gitObserved?: "committed" | "uncommitted";
};

export type FileTreeFolderNode = {
  kind: "folder";
  name: string;
  path: string;
  children: FileTreeEntry[];
  fileCount: number; // recursive count of file leaves under this folder
};

export type FileTreeFileNode = {
  kind: "file";
  name: string;
  path: string;
  file: FileTreeFile;
};

export type FileTreeEntry = FileTreeFolderNode | FileTreeFileNode;

const TOP_LEVEL_AUTO_EXPAND_LIMIT = 12;

function compareEntries(left: FileTreeEntry, right: FileTreeEntry): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function countFiles(entries: FileTreeEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.kind === "file") total += 1;
    else {
      entry.fileCount = countFiles(entry.children);
      total += entry.fileCount;
    }
  }
  return total;
}

/** Builds a folders-first, alphabetical tree from a flat file list ("/"-separated paths). */
export function buildFileTree(files: FileTreeFile[]): FileTreeEntry[] {
  const root: FileTreeEntry[] = [];
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let siblings = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      const path = segments.slice(0, index + 1).join("/");
      let folder = siblings.find((entry): entry is FileTreeFolderNode => entry.kind === "folder" && entry.path === path);
      if (!folder) {
        folder = { kind: "folder", name, path, children: [], fileCount: 0 };
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    const name = segments[segments.length - 1];
    siblings.push({ kind: "file", name, path: file.path, file });
  }
  sortTree(root);
  countFiles(root);
  return root;
}

function sortTree(entries: FileTreeEntry[]) {
  entries.sort(compareEntries);
  for (const entry of entries) if (entry.kind === "folder") sortTree(entry.children);
}

/** Folder paths that are ancestors of `selectedPath` (e.g. "a", "a/b" for "a/b/c.ts"). */
export function ancestorFolderPaths(selectedPath: string | null): ReadonlySet<string> {
  const ancestors = new Set<string>();
  if (!selectedPath) return ancestors;
  const segments = selectedPath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) ancestors.add(segments.slice(0, index + 1).join("/"));
  return ancestors;
}

/** Folders open by default: ancestors of the selection, plus top-level folders with <=12 files total. */
export function defaultOpenFolders(entries: FileTreeEntry[], selectedPath: string | null): ReadonlySet<string> {
  const open = new Set(ancestorFolderPaths(selectedPath));
  for (const entry of entries) if (entry.kind === "folder" && entry.fileCount <= TOP_LEVEL_AUTO_EXPAND_LIMIT) open.add(entry.path);
  return open;
}

export type FileTreeRow =
  | { kind: "folder"; depth: number; node: FileTreeFolderNode; open: boolean }
  | { kind: "file"; depth: number; node: FileTreeFileNode };

/** Flattens the tree into the rows currently visible, given which folders are open. */
export function visibleFileTreeRows(entries: FileTreeEntry[], isOpen: (path: string) => boolean, depth = 0): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "folder") {
      const open = isOpen(entry.path);
      rows.push({ kind: "folder", depth, node: entry, open });
      if (open) rows.push(...visibleFileTreeRows(entry.children, isOpen, depth + 1));
    } else rows.push({ kind: "file", depth, node: entry });
  }
  return rows;
}

export type FileStatusTone = "positive" | "warning" | null;
export type FileStatus = {
  letter: "M" | "U" | "A" | "D" | "R";
  label: "Modified" | "Untracked" | "Added" | "Deleted" | "Renamed";
  tone: FileStatusTone;
};

/**
 * Maps a git porcelain status code to the bounded five-value working-tree status (F3), shown as
 * a single editor-style letter in the tree: amber M, green U (untracked) and A (added), neutral
 * D/R. Unrecognized codes fall back to M.
 */
export function fileStatus(status: string | null | undefined): FileStatus | null {
  const code = status?.trim();
  if (!code) return null;
  if (code === "??") return { letter: "U", label: "Untracked", tone: "positive" };
  if (code.includes("A")) return { letter: "A", label: "Added", tone: "positive" };
  if (code.includes("D")) return { letter: "D", label: "Deleted", tone: null };
  if (code.includes("R")) return { letter: "R", label: "Renamed", tone: null };
  return { letter: "M", label: "Modified", tone: "warning" };
}

/** Alphabetical order for the flat "Changed elsewhere" group (F4), which is never nested. */
export function sortByPath(files: FileTreeFile[]): FileTreeFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}
