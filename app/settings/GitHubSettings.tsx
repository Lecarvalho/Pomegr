"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRepositoryInventory } from "../repository-inventory-client";
import {
  readGitHubStatus,
  signInToGitHub,
  taskIssuesAvailable,
  type GitHubCapability,
  type GitHubConnection,
  type GitHubRepositoryAccess,
  type GitHubSignInStatus,
} from "../components/tasks/task-issues-desktop";
import { SettingRow } from "./SettingRow";

/** At most this many repositories of the inventory are read, one after another. */
export const GITHUB_SETTINGS_REPOSITORY_LIMIT = 16;

/** What the pane draws for the connection. `unreadable`: the first call failed, so no connection is known. */
export type GitHubConnectionReading =
  | { kind: "pending" }
  | { kind: "no_repository" }
  | { kind: "unreadable" }
  | { kind: "read"; connection: GitHubConnection };

/** `access` is null when this repository's call failed or the monitor did not recognize its root. */
export type GitHubRepositoryReading = { id: string; name: string; access: GitHubRepositoryAccess | null };

export type GitHubSignInState = { busy: boolean; status: GitHubSignInStatus | null };

const CONNECTION_CHIPS: Record<GitHubConnection, { label: string; tone: string; dot: boolean }> = {
  connected: { label: "Connected", tone: " positive", dot: true },
  not_signed_in: { label: "Not signed in", tone: " warning", dot: true },
  cli_missing: { label: "Not installed", tone: "", dot: false },
};

const CAPABILITIES: Array<{ id: GitHubCapability; label: string; tone: string }> = [
  { id: "read_issues", label: "Can read issues", tone: " positive" },
  { id: "create_issues", label: "Can create issues", tone: " positive" },
  { id: "issues_disabled", label: "Issues are turned off", tone: " warning" },
  { id: "no_access", label: "No access", tone: "" },
];

const VISIBILITY_LABELS = { private: "Private", public: "Public", unknown: null } as const;

const SIGN_IN_LINES: Record<GitHubSignInStatus, string> = {
  opened: "Finish signing in in the terminal, then choose Check again.",
  cancelled: "",
  cli_missing: "The GitHub CLI was not found on this computer.",
  unsupported_platform: "Signing in from Pomegr is available on Windows.",
  unavailable: "Pomegr could not open the GitHub CLI sign-in. Try again.",
};

function connectionLines(connection: GitHubConnectionReading): string[] {
  switch (connection.kind) {
    case "pending": return ["Checking the GitHub CLI…"];
    case "no_repository": return ["No repository is known yet, so the connection cannot be read."];
    case "unreadable": return ["The connection could not be checked. Choose Check again."];
    default:
      if (connection.connection === "connected") return ["Connected through GitHub CLI"];
      if (connection.connection === "not_signed_in") return ["The GitHub CLI is installed, but no one is signed in."];
      return ["GitHub CLI not installed", "Install it on this computer, then choose Check again."];
  }
}

function RepositoryAccess({ access }: { access: GitHubRepositoryAccess | null }) {
  const visibility = access ? VISIBILITY_LABELS[access.visibility] : null;
  const capabilities = access ? CAPABILITIES.filter(({ id }) => access.capabilities.includes(id)) : [];
  if (!visibility && capabilities.length === 0) return <span className="githubRepositoryUnchecked">Could not be checked.</span>;
  return <>
    {visibility && <span className="commandChip">{visibility}</span>}
    {capabilities.map(({ id, label, tone }) => <span key={id} className={`commandChip${tone}`}>{label}</span>)}
  </>;
}

function ConnectionRow({ connection, reading, signIn, onCheckAgain, onSignIn }: {
  connection: GitHubConnectionReading;
  reading: boolean;
  signIn: GitHubSignInState;
  onCheckAgain?: () => void;
  onSignIn?: () => void;
}) {
  const read = connection.kind === "read" ? connection.connection : null;
  const chip = read ? CONNECTION_CHIPS[read] : null;
  const signInLine = read === "not_signed_in" && signIn.status ? SIGN_IN_LINES[signIn.status] : "";
  return <div className="commandSettingRow githubConnectionRow">
    <div>
      <strong>GitHub CLI</strong>
      {connectionLines(connection).map((line) => <span key={line}>{line}</span>)}
      {signInLine && <span role="status">{signInLine}</span>}
    </div>
    <div className="githubConnectionControls">
      {chip && <span className={`commandChip${chip.tone}`}>{chip.dot && <i aria-hidden="true" />}{chip.label}</span>}
      {read === "not_signed_in" && <button className="commandSecondaryAction" type="button" disabled={signIn.busy} onClick={onSignIn}>Sign in with GitHub CLI</button>}
      <button className="commandQuietAction" type="button" disabled={reading || connection.kind === "no_repository"} onClick={onCheckAgain}>Check again</button>
    </div>
  </div>;
}

/**
 * The GitHub section, drawn from already-read facts only. It owns no bridge call and no state, so `/design-system`
 * renders it from static data. `desktop` false is the browser or LAN form: one row, nothing read.
 */
export function GitHubSettingsPane({ desktop, connection, repositories, omitted = 0, reading = false, signIn = { busy: false, status: null }, headingId = "github-settings-heading", onCheckAgain, onSignIn }: {
  desktop: boolean;
  connection: GitHubConnectionReading;
  repositories: GitHubRepositoryReading[];
  /** How many known repositories lie beyond the limit and were not read. */
  omitted?: number;
  reading?: boolean;
  signIn?: GitHubSignInState;
  headingId?: string;
  onCheckAgain?: () => void;
  onSignIn?: () => void;
}) {
  const connected = connection.kind === "read" && connection.connection === "connected";
  return <section className="githubSettings" aria-labelledby={headingId} aria-busy={desktop ? reading : undefined}>
    <header>
      <h2 id={headingId}>GitHub</h2>
      <p>Pomegr uses your own GitHub CLI session and never reads or stores a GitHub token.</p>
    </header>
    <div className="githubSettingsPanel">
      {!desktop
        ? <SettingRow label="GitHub CLI" description="GitHub is connected in the Pomegr desktop app."><span className="commandComingSoonLabel">Desktop managed</span></SettingRow>
        : <>
          <ConnectionRow connection={connection} reading={reading} signIn={signIn} onCheckAgain={onCheckAgain} onSignIn={onSignIn} />
          {connected && <>
            <div className="commandSettingRow githubRepositoriesHead"><div><strong>Repositories</strong><span>What your account can do in each repository Pomegr knows.</span></div></div>
            <ul className="githubRepositoryList" aria-label="Repositories">
              {repositories.map((repository) => <li key={repository.id} className="commandSettingRow githubRepositoryRow">
                <div><strong className="githubRepositoryName">{repository.name}</strong></div>
                <div className="githubRepositoryAccess"><RepositoryAccess access={repository.access} /></div>
              </li>)}
            </ul>
            {omitted > 0 && <p className="githubSettingsNote">Showing the first {repositories.length} of {repositories.length + omitted} repositories.</p>}
          </>}
        </>}
    </div>
    {desktop && <p className="githubSettingsFootnote">Signing in opens the GitHub CLI&apos;s own sign-in in a terminal. Changing account is done there too.</p>}
  </section>;
}

type Reading = { connection: GitHubConnectionReading; repositories: GitHubRepositoryReading[]; omitted: number };

/**
 * One read: `readGitHubStatus` for each repository, one after another. The connection is the first answer's, and
 * anything but `connected` stops the read there; a later failed call only marks its own repository.
 */
async function readGitHub(repositories: Array<{ id: string; name: string }>, omitted: number): Promise<Reading> {
  const [first, ...rest] = repositories;
  const answer = await readGitHubStatus(first.id);
  if (!answer.ok) return { connection: { kind: "unreadable" }, repositories: [], omitted };
  const { connection } = answer.value;
  if (connection !== "connected") return { connection: { kind: "read", connection }, repositories: [], omitted };
  const rows: GitHubRepositoryReading[] = [{ ...first, access: answer.value.repository }];
  for (const repository of rest) {
    const next = await readGitHubStatus(repository.id);
    rows.push({ ...repository, access: next.ok ? next.value.repository : null });
  }
  return { connection: { kind: "read", connection }, repositories: rows, omitted };
}

function GitHubSettingsDesktop() {
  const { snapshot, loading } = useRepositoryInventory();
  const known = snapshot.repositories;
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<Reading | null>(null);
  const [signIn, setSignIn] = useState<GitHubSignInState>({ busy: false, status: null });
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const autoRead = useRef(false);

  // Set on mount, not at creation: a development double-mount must not leave a read's answer discarded.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const read = useCallback(async () => {
    const list = known.slice(0, GITHUB_SETTINGS_REPOSITORY_LIMIT).map(({ id, displayName }) => ({ id, name: displayName }));
    if (list.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setReading(true);
    setSignIn({ busy: false, status: null });
    try {
      const next = await readGitHub(list, known.length - list.length);
      if (mounted.current) setResult(next);
    } finally {
      inFlight.current = false;
      if (mounted.current) setReading(false);
    }
  }, [known]);

  // Opening the section reads once, as soon as the inventory names a repository; nothing else reads but Check again.
  useEffect(() => {
    if (autoRead.current || loading || known.length === 0) return;
    autoRead.current = true;
    void read();
  }, [loading, known.length, read]);

  const signInToFirst = useCallback(async () => {
    const first = known[0];
    if (!first || signIn.busy) return;
    setSignIn({ busy: true, status: null });
    const status = await signInToGitHub(first.id);
    if (mounted.current) setSignIn({ busy: false, status });
  }, [known, signIn.busy]);

  const connection: GitHubConnectionReading = result ? result.connection : known.length === 0 && !loading ? { kind: "no_repository" } : { kind: "pending" };
  return <GitHubSettingsPane
    desktop
    connection={connection}
    repositories={result?.repositories ?? []}
    omitted={result?.omitted ?? 0}
    reading={reading || (result === null && loading)}
    signIn={signIn}
    onCheckAgain={() => void read()}
    onSignIn={() => void signInToFirst()}
  />;
}

function subscribeAvailability() { return () => {}; }

/** Settings → GitHub. The bridge is the desktop app's: a browser or LAN client sees one row and reads nothing. */
export function GitHubSettings() {
  // Server render and the first client paint both report no bridge, so hydration matches.
  const desktop = useSyncExternalStore(subscribeAvailability, taskIssuesAvailable, () => false);
  return desktop ? <GitHubSettingsDesktop /> : <GitHubSettingsPane desktop={false} connection={{ kind: "pending" }} repositories={[]} />;
}
