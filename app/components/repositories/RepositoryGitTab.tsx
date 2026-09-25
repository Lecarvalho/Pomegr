"use client";

import Link from "next/link";
import type { SessionSummary } from "../../../shared/monitor-contract";
import type { RepositoryDomain } from "../../../shared/session-domain-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { useSessionCatalog } from "../../hooks/SessionCatalogContext";
import { useSessionDomain } from "../../session-domain-store";
import { RelativeTimeText } from "../LiveTime";

export type RepositoryGitTabProps = { repositoryId: string };

function newestLiveSession(sessions: SessionSummary[], repositoryId: string): SessionSummary | null {
  let newest: SessionSummary | null = null;
  for (const session of sessions) {
    if (session.repositoryId !== repositoryId || !session.isLive) continue;
    if (!newest || Date.parse(session.updatedAt) > Date.parse(newest.updatedAt)) newest = session;
  }
  return newest;
}

function commitsHeading(repository: NonNullable<RepositoryDomain["repository"]>) {
  if (!repository.isMain && repository.comparison) return `Commits since ${repository.comparison.branch}`;
  return "Recent commits on the default branch";
}

/** Repository page Git tab: the live commit list that used to live on the session Repository tab
 * (see app/components/dashboard/RepositoryTab.tsx). Only a live session in this repository can
 * supply commits -- a historical session's recorded snapshot never carries a commit list
 * (G16-G18 in the repository-snapshot design contract), and the current working tree is never
 * substituted for it. */
export function RepositoryGitTab({ repositoryId }: RepositoryGitTabProps) {
  const { sessions } = useSessionCatalog();
  const liveSession = newestLiveSession(sessions, repositoryId);
  const result = useSessionDomain({ sessionId: liveSession?.id || "", domain: "repository" }, { historical: false, enabled: Boolean(liveSession) });
  const domain = result.data;

  if (!liveSession) return <section className="panel repositoryGitTabPanel" aria-label="Git">
    <p className="repositoryGitTabEmpty">Commits appear while a session in this repository is live.</p>
  </section>;

  const repository = domain?.repository || null;
  const commits = repository?.commits || [];

  return <section className="panel repositoryGitTabPanel" aria-label="Git">
    <p className="repositoryGitTabSource">
      From the live working tree of <Link className="commandTextLink" href={`/sessions/${encodeSessionRoute(liveSession.id)}?tab=repository`}>{liveSession.title}</Link>
      {domain?.observedAt && <> · checked <RelativeTimeText value={domain.observedAt} /></>}
    </p>
    {!repository
      ? <p className="repositoryGitTabEmpty">{result.unavailable ? "Repository evidence is unavailable for this session." : "Loading commits…"}</p>
      : <>
        <div className="repositoryGitTabListHeader">
          <h2>{commitsHeading(repository)}</h2>
          <span className="repositoryGitTabCount">{commits.length} shown</span>
        </div>
        {commits.length === 0
          ? <p className="repositoryGitTabEmpty">No commits recorded yet.</p>
          : <ul className="repositoryGitTabList">
            {commits.map((commit) => <li className="repositoryGitTabCommit" key={commit.hash}>
              <code className="repositoryGitTabHash">{commit.hash}</code>
              <span className="repositoryGitTabSubject" title={commit.subject}>{commit.subject}</span>
              <time className="repositoryGitTabTime" dateTime={commit.committedAt || undefined}><RelativeTimeText value={commit.committedAt} /></time>
            </li>)}
          </ul>}
      </>}
  </section>;
}
