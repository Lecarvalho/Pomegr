import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { HomeDashboard } from "../../app/HomeDashboard";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { HOME_UPDATE_ID } from "../../app/hooks/useHomePreferences";

// A separate file: the desktop marker store is module state, and this case needs it unsettled.
const desktopWindow = window as Window & { pomegrDesktop?: unknown };
afterEach(() => { delete desktopWindow.pomegrDesktop; window.localStorage.clear(); });

it("keeps the announcement seen through the desktop bridge when browser storage starts empty", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  const setHomeUpdate = vi.fn(async () => null);
  desktopWindow.pomegrDesktop = {
    getDesktopState: async () => ({ homeUpdate: { seenId: HOME_UPDATE_ID, dismissedId: null } }),
    setHomeUpdate,
    onDesktopStateChanged: () => () => {},
  };
  const user = userEvent.setup();
  render(<SessionCatalogProvider sessions={[]}><HomeDashboard /></SessionCatalogProvider>);
  // Already seen in a previous launch: the card waits for the desktop answer and the dialog stays closed.
  const trigger = await screen.findByRole("button", { name: "See what’s new" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(setHomeUpdate).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Got it" }));
  expect(setHomeUpdate).toHaveBeenCalledWith("dismissedId", HOME_UPDATE_ID);
  expect(screen.queryByRole("button", { name: "See what’s new" })).not.toBeInTheDocument();
});
