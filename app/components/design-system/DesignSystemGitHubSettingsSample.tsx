"use client";

import type { ReactNode } from "react";
import { GitHubSettingsPane, type GitHubRepositoryReading } from "../../settings/GitHubSettings";
import { Sample, Section } from "./DesignSystemKit";

const noop = () => undefined;

// Invented repositories; every state a repository row can draw.
const REPOSITORIES: GitHubRepositoryReading[] = [
  { id: "repo-000000000000000000000001", name: "pomegr", access: { visibility: "private", capabilities: ["read_issues", "create_issues"] } },
  { id: "repo-000000000000000000000002", name: "catalogus", access: { visibility: "public", capabilities: ["read_issues", "create_issues"] } },
  { id: "repo-000000000000000000000003", name: "clapline", access: { visibility: "private", capabilities: ["issues_disabled"] } },
  { id: "repo-000000000000000000000004", name: "notes-archive", access: { visibility: "unknown", capabilities: ["no_access"] } },
  { id: "repo-000000000000000000000005", name: "scratch", access: null },
];

// The sixteen repositories a read stops at.
const LIMIT_REPOSITORIES: GitHubRepositoryReading[] = Array.from({ length: 16 }, (_, index) => ({
  id: `repo-${String(index + 1).padStart(24, "0")}`,
  name: `project-${index + 1}`,
  access: { visibility: index % 3 === 0 ? "public" : "private", capabilities: ["read_issues", "create_issues"] },
}));

function Frame({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="designSystemGrid"><Sample label={label} note={note}><div className="designSystemTaskFrame"><div className="commandSettingsPane">{children}</div></div></Sample></div>;
}

export function GitHubSettingsSection() {
  return <Section id="github-settings" title="GitHub settings" lede="Settings → GitHub (GitHubSettingsPane): the GitHub CLI connection and what the account can do in each known repository, as fixed statuses only. It composes the shared settings row, chips and button roles inside one bordered panel and adds no control of its own. Never a username, path, URL or error text.">
    <Frame label="Connected" note="Chips carry the connection, then each repository's visibility (nothing when unknown) and its fixed capability words. A repository that failed or is not recognized reads Could not be checked. Check again is the Quiet role.">
      <GitHubSettingsPane desktop headingId="design-system-github-connected" connection={{ kind: "read", connection: "connected" }} repositories={REPOSITORIES} onCheckAgain={noop} />
    </Frame>
    <Frame label="Connected, more than 16 repositories" note="Only the first 16 are read; a quiet line says so.">
      <GitHubSettingsPane desktop headingId="design-system-github-limit" connection={{ kind: "read", connection: "connected" }} repositories={LIMIT_REPOSITORIES} omitted={4} onCheckAgain={noop} />
    </Frame>
    <Frame label="Not signed in" note="Sign in with GitHub CLI is a Secondary action behind a native confirmation (Windows only); the fixed line after it names the status. No repository is read until the connection is.">
      <GitHubSettingsPane desktop headingId="design-system-github-signed-out" connection={{ kind: "read", connection: "not_signed_in" }} repositories={[]} signIn={{ busy: false, status: "opened" }} onCheckAgain={noop} onSignIn={noop} />
    </Frame>
    <Frame label="GitHub CLI not installed" note="Fixed text that names the CLI; Pomegr offers no install action and builds no link.">
      <GitHubSettingsPane desktop headingId="design-system-github-missing" connection={{ kind: "read", connection: "cli_missing" }} repositories={[]} onCheckAgain={noop} />
    </Frame>
    <Frame label="Reading" note="The section is busy: Check again is disabled and the previous rows stay until the new read is complete.">
      <GitHubSettingsPane desktop reading headingId="design-system-github-reading" connection={{ kind: "read", connection: "connected" }} repositories={REPOSITORIES.slice(0, 2)} onCheckAgain={noop} />
    </Frame>
    <Frame label="Browser or paired LAN" note="One desktop-only row and no read: GitHub is connected in the desktop app.">
      <GitHubSettingsPane desktop={false} headingId="design-system-github-browser" connection={{ kind: "pending" }} repositories={[]} />
    </Frame>
  </Section>;
}
