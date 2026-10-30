import { readFileSync } from "node:fs";
import path from "node:path";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";

// Shared by the focused /design-system tests. Each of those files mounts only the section it checks, never the whole page.

export const REPOSITORY_ID = "repo-0123456789abcdef01234567";

/** The `<section>` that a level-2 heading names. The section must be mounted. */
export function sectionOf(name: string) {
  return screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
}

/** The `.designSystemSample` that carries a label. */
export function sample(root: HTMLElement, label: string) {
  return within(root).getByText(label, { selector: ".designSystemSample > span" }).closest(".designSystemSample") as HTMLElement;
}

/** The value beside a `<dt>` in a sample of readings. */
export function reading(root: HTMLElement, label: string) {
  return within(root).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

export function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** Forbids network use while a sample renders: every test in the file fails when a sample calls `fetch`. */
export function forbidNetwork() {
  const state: { spy: MockInstance | null } = { spy: null };
  beforeEach(() => {
    state.spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network use is forbidden on the design-system page")));
  });
  afterEach(() => {
    const calls = state.spy?.mock.calls.length ?? 0;
    vi.restoreAllMocks();
    window.localStorage.clear();
    expect(calls, "a sample used the network").toBe(0);
  });
  return state;
}

/** Stands in for the client-access module, which reads `/api/client-access` once a component subscribes. */
export const access = { mode: "unknown" as "unknown" | "local" | "lan" };
export function stubClientAccess<T extends object>(actual: T): T {
  return { ...actual, useClientAccess: () => ({ mode: access.mode, canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
}
