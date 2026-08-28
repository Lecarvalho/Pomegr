import type { ReactNode } from "react";
import type { WorkKind } from "../../shared/monitor-contract";

const SHAPES: Record<WorkKind, ReactNode> = {
  shell: <><rect x="2.5" y="3.5" width="15" height="13" /><path d="m5.5 7 3 3-3 3M10.5 13h4" /></>,
  search: <><circle cx="8.5" cy="8.5" r="4.75" /><path d="m12 12 4.25 4.25" /></>,
  read: <><path d="M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 9h5M7.5 12h5" /></>,
  write: <><path d="M5 2.5h7l3 3v3M12 2.5v3h3" /><path d="m7 15.5.5-2.75 5.75-5.75 2.25 2.25L9.75 15zM12.25 8l2.25 2.25" /></>,
  test: <><path d="M7 2.5h6M8.5 2.5v5l-4 7a2 2 0 0 0 1.75 3h7.5a2 2 0 0 0 1.75-3l-4-7v-5" /><path d="M6.5 12h7" /></>,
  build: <><rect x="3" y="3" width="6" height="6" /><rect x="11" y="3" width="6" height="6" /><rect x="7" y="11" width="6" height="6" /></>,
  git: <><circle cx="6" cy="4" r="1.75" /><circle cx="14" cy="15.5" r="1.75" /><path d="M6 5.75v9.75M7.75 6.5h2.75A3.5 3.5 0 0 1 14 10v3.75" /></>,
  git_push: <><circle cx="6" cy="15.5" r="1.75" /><path d="M6 13.75V5.5M3.75 7.75 6 5.5l2.25 2.25M8 11h3a3 3 0 0 0 3-3V4.5M11.75 6.75 14 4.5l2.25 2.25" /></>,
  pull_request: <><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="16" r="1.5" /><circle cx="15" cy="16" r="1.5" /><path d="M5 5.5v9M9 5h2a4 4 0 0 1 4 4v5.5M9 2l-3 3 3 3" /></>,
  process: <><path d="M15.5 7A6 6 0 1 0 16 12M15.5 3.5V7H12" /><path d="M10 6v4l2.5 1.5" /></>,
  web: <><circle cx="10" cy="10" r="7" /><path d="M3 10h14M10 3a11 11 0 0 1 0 14M10 3a11 11 0 0 0 0 14" /></>,
  image: <><rect x="2.5" y="3.5" width="15" height="13" /><circle cx="7" cy="8" r="1.5" /><path d="m4.5 14 3.5-3 2.5 2 2-2 3 3" /></>,
  input: <><path d="M3 4h14v9H9l-4 3v-3H3z" /><path d="M7 8h6M7 10.5h4" /></>,
  transfer: <><path d="M4.5 2.5h7l3 3v5M11.5 2.5v3h3" /><path d="M8 14h8M13 11l3 3-3 3M4.5 8v9h5" /></>,
  skill: <><path d="M10 2.5v15M2.5 10h15M4.7 4.7l10.6 10.6M15.3 4.7 4.7 15.3" /><circle cx="10" cy="10" r="2.25" /></>,
  report: <><path d="M2.5 11h3l2-5 4 9 2-4H17.5" /><path d="M3 3.5h14v13H3z" /></>,
  agent: <><circle cx="5" cy="5" r="2" /><circle cx="15" cy="5" r="2" /><circle cx="10" cy="15" r="2" /><path d="m6.5 6.5 2.25 6M13.5 6.5l-2.25 6M7 5h6" /></>,
  integration: <><path d="M7 2.5v4M13 2.5v4M5 6.5h10v2a5 5 0 0 1-5 5v4M7 17.5h6" /></>,
  wait: <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l3 2" /></>,
};

export function WorkKindIcon({ kind, className = "" }: { kind: WorkKind; className?: string }) {
  return <svg aria-hidden="true" className={`workKindIcon ${className}`.trim()} data-work-kind={kind} focusable="false" viewBox="0 0 20 20">{SHAPES[kind]}</svg>;
}
