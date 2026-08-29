import type { ReactNode, SVGProps } from "react";

export type CommandIconName =
  | "activity"
  | "agents"
  | "arrow"
  | "bell"
  | "chart"
  | "close"
  | "dashboard"
  | "external"
  | "git"
  | "grid"
  | "home"
  | "limits"
  | "menu"
  | "more"
  | "repositories"
  | "search"
  | "session"
  | "settings"
  | "sessions"
  | "spark"
  | "timer";

const paths: Record<CommandIconName, ReactNode> = {
  activity: <><path d="M3 12h4l2.2-7 5.4 14 2.2-7H21" /></>,
  agents: <><circle cx="12" cy="7" r="3" /><path d="M5 21a7 7 0 0 1 14 0M5 11h2M17 11h2" /></>,
  arrow: <><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  chart: <><path d="M4 19V5M4 19h16" /><path d="m7 15 3-4 3 2 5-7" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  git: <><circle cx="7" cy="5" r="2" /><circle cx="17" cy="19" r="2" /><circle cx="17" cy="5" r="2" /><path d="M9 5h6M7 7v8a4 4 0 0 0 4 4h4M17 7v10" /></>,
  grid: <><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></>,
  home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10M9 20v-6h6v6" /></>,
  limits: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  repositories: <><path d="M4 6.5 12 3l8 3.5v11L12 21l-8-3.5z" /><path d="M4 6.5 12 10l8-3.5M12 10v11" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  session: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 8h10M7 12h6M7 16h4" /></>,
  settings: <><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /><circle cx="12" cy="12" r="4" /></>,
  sessions: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 8h10M7 12h6M7 16h4" /></>,
  spark: <><path d="m12 3 1.6 6.4L20 11l-6.4 1.6L12 19l-1.6-6.4L4 11l6.4-1.6z" /></>,
  timer: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9 3h6" /></>,
};

export function CommandIcon({ name, size = "default", ...props }: { name: CommandIconName; size?: "default" | "small" } & Omit<SVGProps<SVGSVGElement>, "children">) {
  return <svg className={`commandIcon${size === "small" ? " commandIconSmall" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
