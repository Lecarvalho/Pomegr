import { render, screen, within } from "@testing-library/react";
import type { SessionSummaryDomain } from "../../shared/session-domain-contract";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionTabs } from "../../app/components/dashboard/SessionTabs";
import type { SessionTab } from "../../app/components/dashboard/session-route";
import { sessionSummaryFixture } from "./session-summary-test-fixture";

afterEach(() => { vi.restoreAllMocks(); });

function mount(active: SessionTab, overrides: Parameters<typeof sessionSummaryFixture>[0] = {}) {
  const onSelect = vi.fn();
  const view = render(<SessionTabs active={active} summary={sessionSummaryFixture(overrides)} onSelect={onSelect} />);
  return { ...view, onSelect };
}

describe("SessionTabs", () => {
  it("hides Resources for a historical session with unconfirmed data (hasData null)", () => {
    mount("overview", { resourceAvailability: { readiness: "unavailable", hasData: null } });
    const desktop = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(desktop).queryByRole("tab", { name: "Resources" })).not.toBeInTheDocument();
  });

  it("hides Resources when readiness is ready but there is no data", () => {
    mount("overview", { resourceAvailability: { readiness: "ready", hasData: false } });
    const desktop = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(desktop).queryByRole("tab", { name: "Resources" })).not.toBeInTheDocument();
  });

  it("shows Resources only once evidence confirms data", () => {
    mount("overview", { resourceAvailability: { readiness: "ready", hasData: true } });
    const desktop = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(desktop).getByRole("tab", { name: "Resources" })).toBeInTheDocument();
  });

  it("counts the files the session affected on the Repository tab, not uncommitted files", () => {
    const base = sessionSummaryFixture().repository;
    const { unmount } = mount("overview", { repository: { ...base, changedFiles: 0, touchedFiles: 6 } });
    let desktop = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(desktop).getByRole("tab", { name: "Repository6" })).toBeInTheDocument();
    unmount();
    mount("overview", { repository: { ...base, changedFiles: 4, touchedFiles: null } });
    desktop = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    expect(within(desktop).getByRole("tab", { name: "Repository" })).toBeInTheDocument();
  });

  it("falls back to Overview when the active tab (e.g. ?tab=resources) is hidden", () => {
    const { onSelect } = mount("resources", { resourceAvailability: { readiness: "unavailable", hasData: null } });
    expect(onSelect).toHaveBeenCalledWith("overview");
  });

  it("does not fall back when the active tab is available", () => {
    const { onSelect } = mount("agents");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not redirect off Resources while a live session's readiness is still loading (hasData null)", () => {
    const { onSelect } = mount("resources", { resourceAvailability: { readiness: "loading", hasData: null } });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("redirects off Resources exactly once a historical session's readiness resolves to hidden", () => {
    const onSelect = vi.fn();
    const summary = (readiness: SessionSummaryDomain["resourceAvailability"]["readiness"], hasData: boolean | null) =>
      sessionSummaryFixture({ resourceAvailability: { readiness, hasData } });
    const { rerender } = render(<SessionTabs active="resources" summary={summary("loading", null)} onSelect={onSelect} />);
    expect(onSelect).not.toHaveBeenCalled();
    rerender(<SessionTabs active="resources" summary={summary("unavailable", null)} onSelect={onSelect} />);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("overview");
  });

  it("does not re-run the redirect effect on an unrelated re-render with the same resource readiness", () => {
    const onSelect = vi.fn();
    const summary = sessionSummaryFixture({ resourceAvailability: { readiness: "unavailable", hasData: null } });
    const { rerender } = render(<SessionTabs active="overview" summary={summary} onSelect={onSelect} />);
    expect(onSelect).not.toHaveBeenCalled();
    // A fresh summary object with the same primitive readiness/hasData values
    // simulates an unrelated poll re-render; the effect must not re-fire
    // (and here it shouldn't fire at all, since the active tab is Overview).
    rerender(<SessionTabs active="overview" summary={sessionSummaryFixture({ resourceAvailability: { readiness: "unavailable", hasData: null } })} onSelect={onSelect} />);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("supports arrow-key roving on the desktop tablist, wrapping at the ends", async () => {
    mount("overview");
    const desktop = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    const tabs = within(desktop).getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("tabIndex", "0");
    expect(tabs.slice(1).every((tab) => tab.getAttribute("tabIndex") === "-1")).toBe(true);
    tabs[0].focus();
    await userEvent.setup().keyboard("{ArrowLeft}");
    expect(tabs[tabs.length - 1]).toHaveFocus();
    await userEvent.setup().keyboard("{Home}");
    expect(tabs[0]).toHaveFocus();
    await userEvent.setup().keyboard("{End}");
    expect(tabs[tabs.length - 1]).toHaveFocus();
  });

  it("supports arrow-key roving on the phone tablist across the four primary tabs", async () => {
    mount("overview");
    const phoneList = document.querySelector(".sessionPhoneTablist") as HTMLElement;
    const tabs = within(phoneList).getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    tabs[0].focus();
    await userEvent.setup().keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    await userEvent.setup().keyboard("{ArrowLeft}");
    expect(tabs[0]).toHaveFocus();
  });

  it("does not mix role=tab with aria-haspopup on the phone More trigger", () => {
    mount("overview");
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    expect(more).not.toHaveAttribute("role", "tab");
  });

  it("opens the More menu, selects a secondary tab, and returns focus to the trigger", async () => {
    const { onSelect } = mount("overview");
    const user = userEvent.setup();
    const more = screen.getByRole("button", { name: "More" });
    await user.click(more);
    const menu = screen.getByRole("menu", { name: "More session sections" });
    const resourcesItem = within(menu).getByRole("menuitem", { name: "Resources" });
    await user.click(resourcesItem);
    expect(onSelect).toHaveBeenCalledWith("resources");
    expect(more).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("excludes a hidden Resources tab from the More menu", async () => {
    mount("overview", { resourceAvailability: { readiness: "unavailable", hasData: null } });
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More session sections" });
    expect(within(menu).queryByRole("menuitem", { name: "Resources" })).not.toBeInTheDocument();
  });

  it("gives the phone nav and its inner tablist distinct accessible names", () => {
    mount("overview");
    const phoneNav = document.querySelector("nav.sessionPhoneTabs") as HTMLElement;
    const phoneTablist = document.querySelector(".sessionPhoneTablist") as HTMLElement;
    expect(phoneNav.getAttribute("aria-label")).not.toBe(phoneTablist.getAttribute("aria-label"));
  });

  it("gives each desktop tab an id and aria-controls pointing at the shared session panel", () => {
    mount("agents");
    const desktop = document.querySelector(".sessionDesktopTabs") as HTMLElement;
    const agentsTab = within(desktop).getByRole("tab", { name: /Agents/ });
    expect(agentsTab).toHaveAttribute("id", "session-tab-agents");
    expect(agentsTab).toHaveAttribute("aria-controls", "session-tab-panel");
  });
});
