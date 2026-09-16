export const SESSION_TABS = ["overview", "agents", "activities", "signals", "repository", "resources", "details"] as const;

export type SessionTab = (typeof SESSION_TABS)[number];
export type SessionRouteQuery = {
  tab?: string;
  agent?: string;
  request?: string;
  path?: string;
};

export function parseSessionTab(value: string | undefined): SessionTab {
  return SESSION_TABS.includes(value as SessionTab) ? value as SessionTab : "overview";
}

export function sessionQueryString(query: SessionRouteQuery, changes: Partial<Record<keyof SessionRouteQuery, string | null>>) {
  const params = new URLSearchParams();
  for (const key of ["tab", "agent", "request", "path"] as const) {
    const value = Object.prototype.hasOwnProperty.call(changes, key) ? changes[key] : query[key];
    if (value) params.set(key, value);
  }
  return params.toString();
}
