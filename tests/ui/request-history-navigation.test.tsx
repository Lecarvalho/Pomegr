import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HistoryLocateHarness, setPhone, snapshot } from "./requests-actions-test-fixtures";

afterEach(() => vi.unstubAllGlobals());

it.each(["bar", "step"])("keeps a newer loaded %s selection when an older request lookup finishes", async (action) => {
  setPhone(false);
  const requests = Array.from({ length: 180 }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }));
  let finish!: () => void;
  const fetchPage = vi.fn(async (url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    const locating = params.has("requestId");
    const offset = locating ? 0 : 120;
    const response = { ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total: 180, offset, linkedCount: 0, items: requests.slice(offset, offset + 60) }) };
    return locating ? new Promise((resolve) => { finish = () => resolve(response); }) : response;
  });
  vi.stubGlobal("fetch", fetchPage);
  render(<HistoryLocateHarness sessionId="replace-lookup" requests={[]} />);
  await screen.findByRole("heading", { name: "Request #180" });
  fireEvent.click(screen.getByRole("button", { name: "Locate absent request" }));
  if (action === "bar") fireEvent.click(screen.getByRole("button", { name: /^Request #175,/ }));
  else fireEvent.click(screen.getByRole("button", { name: "Prev" }));
  await act(async () => { finish(); });
  expect(screen.getByRole("heading", { name: `Request #${action === "bar" ? 175 : 179}` })).toBeInTheDocument();
  expect(fetchPage).toHaveBeenCalledTimes(2);
});
