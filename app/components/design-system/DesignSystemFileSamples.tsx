"use client";

import { useState } from "react";
import type { FileHistoryResponse } from "../../../shared/repository-files-contract";
import { SessionFilePanel } from "../dashboard/SessionFilePanel";
import { FileHistoryPanel } from "../repositories/FileHistoryPanel";
import { FileTree, type FileTreeFile } from "../repositories/FileTree";
import { Sample, Section } from "./DesignSystemKit";

const FILE_TREE_SESSION_FILES: FileTreeFile[] = [
  { path: "app/components/command-center/CommandCenterShell.tsx", fileId: "f101", status: "M" },
  { path: "app/components/dashboard/SessionTabs.tsx", fileId: "f102", status: "??" },
  { path: "app/components/dashboard/RequestLanes.tsx", fileId: "f103", status: "??" },
  { path: "app/Dashboard.tsx", fileId: "f104", status: "M" },
  { path: "app/components/dashboard/SessionFilePanel.tsx", fileId: "f105", status: null, recordedKind: "created" },
  { path: "app/components/dashboard/RepositoryTab.tsx", fileId: "f106", status: null, recordedKind: "edited" },
  { path: "app/components/dashboard/GitObservedSample.tsx", fileId: null, status: null, gitObserved: "committed", gitChange: "added" },
];
const FILE_TREE_SESSION_ELSEWHERE: FileTreeFile[] = [
  { path: "docs/internal/architecture/observation-cache.md", fileId: null, status: "M" },
  { path: "tests/ui/pomegr-design-contract.test.tsx", fileId: null, status: "M" },
];
const FILE_TREE_REPOSITORY_FILES: FileTreeFile[] = [
  { path: "app/components/dashboard/Dashboard.tsx", fileId: "f201", sessionCount: 4 },
  { path: "app/components/dashboard/SessionTabs.tsx", fileId: "f202", sessionCount: 1 },
  { path: "app/globals.css", fileId: "f203", sessionCount: 0, muted: true },
  { path: "app/layout.tsx", fileId: null, sessionCount: null, muted: true },
];
const FILE_TREE_REPOSITORY_FOLDER_COUNTS = new Map([
  ["app", 5], ["app/components", 5], ["app/components/dashboard", 5],
]);

export function FileTreeSection() {
  const [sessionSelected, setSessionSelected] = useState("app/components/command-center/CommandCenterShell.tsx");
  const [repositorySelected, setRepositorySelected] = useState("app/components/dashboard/Dashboard.tsx");
  return <Section id="file-tree" title="File tree" lede="FileTree (app/components/repositories/FileTree.tsx) builds folders from a flat file list and fetches nothing. Session scope shows a right-aligned editor-style status letter, a quiet Git-observed glyph for rows no tool recorded, and a Changed elsewhere group; repository scope shows distinct-session counts and mutes files with no recorded history.">
    <div className="designSystemGrid">
      <Sample label="Session scope" note="GitObservedSample.tsx carries the quiet Git-observed glyph and the footer's How to read this popover.">
        <FileTree
          scope="session"
          rootLabel="Pomegr"
          files={FILE_TREE_SESSION_FILES}
          elsewhere={FILE_TREE_SESSION_ELSEWHERE}
          selectedPath={sessionSelected}
          onSelect={(file) => setSessionSelected(file.path)}
          emptyText="No files touched in this session."
        />
      </Sample>
      <Sample label="Repository scope">
        <FileTree
          scope="repository"
          rootLabel="Pomegr"
          files={FILE_TREE_REPOSITORY_FILES}
          folderCounts={FILE_TREE_REPOSITORY_FOLDER_COUNTS}
          selectedPath={repositorySelected}
          onSelect={(file) => setRepositorySelected(file.path)}
          emptyText="No files recorded for this repository."
        />
      </Sample>
    </div>
  </Section>;
}

const FILE_HISTORY_SAMPLE_TIME = Date.parse("2026-09-22T14:02:00.000Z");
const FILE_HISTORY_SAMPLE: FileHistoryResponse = {
  kind: "history", revision: 1, readiness: "ready",
  repositoryId: "repo-0123456789abcdef01234567", fileId: "f201", path: "app/components/dashboard/Dashboard.tsx",
  sessions: [
    {
      sessionId: "claude:design-system-current", title: "IA and progressive-disclosure audit for Pomegr UI",
      provider: "claude", live: true, kind: "edited", editCount: 2, newestAt: new Date(FILE_HISTORY_SAMPLE_TIME).toISOString(),
      agents: [{ id: "primary", label: "Primary", assignment: null, model: null }, { id: "explore", label: "Inventory sitemap", assignment: null, model: null }], pathAtTime: null,
    },
    {
      sessionId: "codex:design-system-readiness", title: "Clarify session readiness states",
      provider: "codex", live: false, kind: "edited", editCount: 1, newestAt: new Date(FILE_HISTORY_SAMPLE_TIME - 12_600_000).toISOString(),
      agents: [{ id: "primary", label: null, assignment: null, model: null }], pathAtTime: null,
    },
    {
      sessionId: "claude:design-system-activity-nav", title: "Add request activity navigation",
      provider: "claude", live: false, kind: "moved", editCount: 3, newestAt: new Date(FILE_HISTORY_SAMPLE_TIME - 84_960_000).toISOString(),
      agents: [{ id: "primary", label: "UI builder", assignment: null, model: null }], pathAtTime: "app/components/RequestLanes.tsx",
    },
    {
      sessionId: "claude:design-system-repo-panel", title: "Introduce the repository panel",
      provider: "claude", live: false, kind: "created", editCount: 0, newestAt: new Date(FILE_HISTORY_SAMPLE_TIME - 1_359_060_000).toISOString(),
      agents: [{ id: "primary", label: null, assignment: null, model: null }], pathAtTime: null,
    },
  ],
  unattributedChanges: 2, truncated: false,
};
const FILE_HISTORY_SAMPLE_EMPTY: FileHistoryResponse = {
  kind: "history", revision: 1, readiness: "ready",
  repositoryId: "repo-0123456789abcdef01234567", fileId: null, path: "app/unseen.ts",
  sessions: [], unattributedChanges: 0, truncated: false,
};

export function FileHistoryPanelSection() {
  return <Section id="file-history-panel" title="File history panel" lede="FileHistoryPanel (app/components/repositories/FileHistoryPanel.tsx) renders on the repository Files tab the committed session history the caller already fetched; it never fetches on its own. A moved entry shows its old path, and every state shares one panel frame. The session Repository tab uses SessionFilePanel instead, showing only that session's change.">
    <div className="designSystemGrid">
      <Sample label="Session file panel" note="SessionFilePanel: this session's recorded change only, fetch-free, with the repository-page link for full history.">
        <SessionFilePanel repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/components/dashboard/Dashboard.tsx" workingTreeStatus="M" readiness="ready"
          file={{ source: "recorded", fileId: "f12", path: "app/components/dashboard/Dashboard.tsx", kind: "created", changeCount: 3, lastObservedAt: "2026-09-22T11:40:00.000Z", agents: [{ id: "primary", label: "Main", assignment: null, model: "claude-opus-5-5", changeCount: 2 }, { id: "agent-2", label: "Explore", assignment: "Map the dashboard components", model: "claude-sonnet-5-5", changeCount: 1 }] }} onOpenAgent={() => {}} />
      </Sample>
      <Sample label="Session file panel, Git-observed" note="No tool recorded the file; Git saw it change in the session window.">
        <SessionFilePanel repositoryId="repo-0123456789abcdef01234567" repositoryLabel="Pomegr" path="app/committed.ts" workingTreeStatus={null} readiness="ready" file={{ path: "app/committed.ts", source: "committed", change: "added" }} />
      </Sample>
      <Sample label="Repository side" note="Copy path action.">
        <FileHistoryPanel repositoryLabel="Pomegr" path="app/components/dashboard/Dashboard.tsx" workingTreeStatus={null} history={FILE_HISTORY_SAMPLE} />
      </Sample>
      <Sample label="No recorded sessions" note="Ready readiness with zero sessions for the selected path.">
        <FileHistoryPanel repositoryLabel="Pomegr" path="app/unseen.ts" workingTreeStatus={null} history={FILE_HISTORY_SAMPLE_EMPTY} />
      </Sample>
      <Sample label="Loading" note="history is null until the first committed response arrives.">
        <FileHistoryPanel repositoryLabel="Pomegr" path="app/components/dashboard/Dashboard.tsx" workingTreeStatus={null} history={null} />
      </Sample>
    </div>
  </Section>;
}
