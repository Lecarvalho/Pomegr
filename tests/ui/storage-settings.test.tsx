import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageSettingsBridge, StorageSettingsResult, StorageSettingsState } from "../../shared/storage-settings-contract";
import type { StorageSnapshot } from "../../shared/storage-contract";
import { SettingsPage } from "../../app/settings/SettingsPage";
import {
  StorageUsageBar,
  cleanupStatusText,
  formatStorageBytes,
  storageMeterFill,
  storageStatusLine,
  storageUsageText,
} from "../../app/settings/StorageSettings";

const baseSnapshot: StorageSnapshot = {
  revision: 1,
  readiness: "ready",
  databaseBytes: 380 * 1024 * 1024,
  thresholdBytes: 500 * 1024 * 1024,
  percent: 76,
  oldestRetainedDay: "2026-06-14",
  lastPrunedAt: "2026-06-20T12:00:00.000Z",
  retentionDays: 90,
  cleanupStatus: "normal",
};

const desktopState: StorageSettingsState = {
  canSave: true,
  pendingChanges: false,
  values: { retentionDays: 90, storeMaxMb: 500 },
};

function result(status: StorageSettingsResult["status"], state: StorageSettingsState | null = desktopState): StorageSettingsResult {
  return { status, state };
}

function setupDesktop(initial = desktopState) {
  const bridge: StorageSettingsBridge = {
    getStorageSettings: vi.fn(async () => initial),
    setStorageSetting: vi.fn(async () => result("ready", { ...initial, pendingChanges: true })),
    discardStorageSettings: vi.fn(async () => result("ready", { ...initial, pendingChanges: false })),
    saveStorageSettings: vi.fn(async () => result("restarting", null)),
  };
  Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: bridge });
  return bridge;
}

function stubStorageFetch(body: unknown = baseSnapshot) {
  return vi.fn(async () => Response.json(body));
}

afterEach(() => {
  Reflect.deleteProperty(window, "pomegrDesktop");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Storage formatting helpers", () => {
  it("formats bytes with the documented MB/GB rules", () => {
    expect(formatStorageBytes(8.3 * 1024 * 1024)).toBe("8.3 MB");
    expect(formatStorageBytes(380 * 1024 * 1024)).toBe("380 MB");
    expect(formatStorageBytes(500 * 1024 * 1024)).toBe("500 MB");
    expect(formatStorageBytes(1024 * 1024 * 1024)).toBe("1 GB");
    expect(formatStorageBytes(1536 * 1024 * 1024)).toBe("1.5 GB");
    expect(formatStorageBytes(2048 * 1024 * 1024)).toBe("2 GB");
  });

  it("clamps the meter fill to 0-100", () => {
    expect(storageMeterFill(76)).toBe(76);
    expect(storageMeterFill(100)).toBe(100);
    expect(storageMeterFill(110)).toBe(100);
    expect(storageMeterFill(-5)).toBe(0);
  });

  it("gives cleanup status wording for both statuses and nothing for the ordinary state", () => {
    expect(cleanupStatusText("cleanup_pending")).toBe("Cleanup pending");
    expect(cleanupStatusText("protected_excess")).toBe("Preserved history exceeds the cleanup threshold.");
    expect(cleanupStatusText("normal")).toBe("");
    expect(cleanupStatusText(null)).toBe("");
  });

  it("builds the usage text from a snapshot and degrades honestly when unavailable", () => {
    expect(storageUsageText(baseSnapshot)).toBe("380 MB / 500 MB · 76%");
    expect(storageUsageText({ ...baseSnapshot, databaseBytes: 550 * 1024 * 1024, percent: 110 })).toBe("550 MB / 500 MB · 110%");
    expect(storageUsageText(null)).toBe("Storage usage unavailable");
    expect(storageUsageText({ ...baseSnapshot, readiness: "loading" })).toBe("Storage usage unavailable");
    expect(storageUsageText({ ...baseSnapshot, readiness: "unavailable" })).toBe("Storage usage unavailable");
    expect(storageUsageText({ ...baseSnapshot, databaseBytes: null })).toBe("Storage usage unavailable");
    expect(storageUsageText({ ...baseSnapshot, percent: null })).toBe("Storage usage unavailable");
  });

  it("builds the storage status line, including its documented fallbacks", () => {
    const now = Date.parse("2026-06-20T12:02:00.000Z");
    const snapshot = { ...baseSnapshot, databaseBytes: 148 * 1024 * 1024 };
    expect(storageStatusLine(snapshot, now)).toBe("148 MB · oldest retained 14 Jun 2026 · last prune 2m ago");
    expect(storageStatusLine({ ...snapshot, oldestRetainedDay: null }, now)).toBe("148 MB · no retained curves · last prune 2m ago");
    expect(storageStatusLine({ ...snapshot, lastPrunedAt: null }, now)).toBe("148 MB · oldest retained 14 Jun 2026 · not pruned yet");
    expect(storageStatusLine({ ...snapshot, readiness: "unavailable" }, now)).toBe("Unavailable");
    expect(storageStatusLine({ ...snapshot, readiness: "rebuilding" }, now)).toBe("Rebuilding");
    expect(storageStatusLine(null, now)).toBe("Unavailable");
  });
});

describe("StorageUsageBar", () => {
  it("shows the ordinary case with its exact fill", () => {
    render(<StorageUsageBar snapshot={baseSnapshot} />);
    expect(screen.getByText("380 MB / 500 MB · 76%")).toBeInTheDocument();
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(meter).toHaveAttribute("aria-valuenow", "76");
    expect(meter).toHaveAttribute("aria-valuetext", "380 MB / 500 MB · 76%");
  });

  it("shows the 100% case with a full fill", () => {
    render(<StorageUsageBar snapshot={{ ...baseSnapshot, databaseBytes: 500 * 1024 * 1024, percent: 100 }} />);
    expect(screen.getByText("500 MB / 500 MB · 100%")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
  });

  it("prints the real over-100 percentage while the fill clamps at 100 and shows cleanup wording", () => {
    render(<StorageUsageBar snapshot={{ ...baseSnapshot, databaseBytes: 550 * 1024 * 1024, percent: 110, cleanupStatus: "cleanup_pending" }} />);
    expect(screen.getByText("550 MB / 500 MB · 110%")).toBeInTheDocument();
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter).toHaveAttribute("aria-valuetext", "550 MB / 500 MB · 110%");
    expect(screen.getByRole("status")).toHaveTextContent("Cleanup pending");
  });

  it("shows protected-excess wording", () => {
    render(<StorageUsageBar snapshot={{ ...baseSnapshot, cleanupStatus: "protected_excess" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Preserved history exceeds the cleanup threshold.");
  });

  it("renders nothing for the ordinary cleanup status", () => {
    render(<StorageUsageBar snapshot={baseSnapshot} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("never fabricates a 0% reading when usage is unavailable", () => {
    const { container } = render(<StorageUsageBar snapshot={null} />);
    expect(container.querySelector(".storageUsageText")?.textContent).toBe("Storage usage unavailable");
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("treats loading and unavailable readiness, and null byte/percent fields, as unavailable", () => {
    for (const snapshot of [
      { ...baseSnapshot, readiness: "loading" as const },
      { ...baseSnapshot, readiness: "unavailable" as const },
      { ...baseSnapshot, databaseBytes: null },
      { ...baseSnapshot, percent: null },
    ]) {
      const { container, unmount } = render(<StorageUsageBar snapshot={snapshot} />);
      expect(container.querySelector(".storageUsageText")?.textContent).toBe("Storage usage unavailable");
      expect(screen.queryByRole("meter")).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("Storage settings page", () => {
  it("keeps the Storage tab directly after Providers and before Data display, with no bridge present", async () => {
    vi.stubGlobal("fetch", stubStorageFetch());
    render(<SettingsPage initialSection="storage" />);
    const tabs = await screen.findAllByRole("tab");
    const labels = tabs.map((tab) => tab.textContent);
    const providersIndex = labels.indexOf("Providers");
    const storageIndex = labels.indexOf("Storage");
    const dataIndex = labels.indexOf("Data display");
    expect(storageIndex).toBeGreaterThan(-1);
    expect(storageIndex).toBeGreaterThan(providersIndex);
    expect(storageIndex).toBeLessThan(dataIndex);
    expect(window).not.toHaveProperty("pomegrDesktop");
  });

  it("treats a malformed /api/storage body as unavailable rather than throwing", async () => {
    vi.stubGlobal("fetch", stubStorageFetch({ readiness: "ready" }));
    render(<SettingsPage initialSection="storage" />);
    await screen.findByRole("heading", { name: "Storage" });
    await waitFor(() => expect(screen.getByText("Storage usage unavailable")).toBeInTheDocument());
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("polls /api/storage on mount and again after 30 seconds", async () => {
    vi.useFakeTimers();
    const fetchStorage = stubStorageFetch();
    vi.stubGlobal("fetch", fetchStorage);
    render(<SettingsPage initialSection="storage" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchStorage).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchStorage).toHaveBeenCalledTimes(2);
  });

  it("renders read-only, disabled controls in the browser with the monitor's current values and no footer or bridge calls", async () => {
    const fetchStorage = stubStorageFetch({ ...baseSnapshot, retentionDays: 180, thresholdBytes: 1024 * 1024 * 1024 });
    vi.stubGlobal("fetch", fetchStorage);
    render(<SettingsPage initialSection="storage" />);
    await screen.findByRole("heading", { name: "Storage" });
    expect(screen.getByText("Storage settings are read-only in the browser. Open the desktop app to change them.")).toBeInTheDocument();

    const pressed = await screen.findByRole("button", { name: "180 days" });
    await waitFor(() => expect(pressed).toHaveAttribute("aria-pressed", "true"));
    expect(pressed).toBeDisabled();
    for (const label of ["30 days", "90 days", "365 days", "Keep all"]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }

    const select = screen.getByRole("combobox", { name: "Resource history cleanup threshold" });
    expect(select).toBeDisabled();
    await waitFor(() => expect(select).toHaveValue("1024"));

    expect(screen.queryByRole("button", { name: "Save and restart Pomegr" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(fetchStorage).toHaveBeenCalledWith("/api/storage", { cache: "no-store", credentials: "same-origin" });
    expect(window).not.toHaveProperty("pomegrDesktop");
  });

  it("calls the desktop bridge for segment and select changes and reflects the draft", async () => {
    vi.stubGlobal("fetch", stubStorageFetch());
    const bridge = setupDesktop();
    render(<SettingsPage initialSection="storage" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Storage" });
    await waitFor(() => expect(bridge.getStorageSettings).toHaveBeenCalled());

    const retentionButton = await screen.findByRole("button", { name: "365 days" });
    await waitFor(() => expect(retentionButton).toBeEnabled());
    await user.click(retentionButton);
    expect(bridge.setStorageSetting).toHaveBeenCalledExactlyOnceWith("retentionDays", 365);

    const select = screen.getByRole("combobox", { name: "Resource history cleanup threshold" });
    await user.selectOptions(select, "1 GB");
    expect(bridge.setStorageSetting).toHaveBeenCalledWith("storeMaxMb", 1024);
  });

  it("disables Save without a pending change and enables it once one exists", async () => {
    vi.stubGlobal("fetch", stubStorageFetch());
    const bridge = setupDesktop({ ...desktopState, pendingChanges: false });
    render(<SettingsPage initialSection="storage" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Storage" });
    const saveButton = await screen.findByRole("button", { name: "Save and restart Pomegr" });
    await waitFor(() => expect(saveButton).toBeDisabled());
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();

    vi.mocked(bridge.setStorageSetting).mockResolvedValueOnce(result("ready", { ...desktopState, pendingChanges: true }));
    await user.click(screen.getByRole("button", { name: "30 days" }));
    expect(saveButton).toBeEnabled();
  });

  it("shows the Saving label only for the save action", async () => {
    vi.stubGlobal("fetch", stubStorageFetch());
    const bridge = setupDesktop({ ...desktopState, pendingChanges: true });
    let finishSave!: (value: StorageSettingsResult) => void;
    vi.mocked(bridge.saveStorageSettings).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<SettingsPage initialSection="storage" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Storage" });
    const saveButton = await screen.findByRole("button", { name: "Save and restart Pomegr" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeInTheDocument();
    await act(async () => finishSave(result("restarting", null)));
    expect(screen.getByRole("status")).toHaveTextContent("Pomegr is restarting with the new storage settings.");
  });

  it("shows the documented result messages without exposing native detail", async () => {
    vi.stubGlobal("fetch", stubStorageFetch());
    const pending = { ...desktopState, pendingChanges: true };
    const bridge = setupDesktop(pending);
    render(<SettingsPage initialSection="storage" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Storage" });
    const saveButton = await screen.findByRole("button", { name: "Save and restart Pomegr" });
    await waitFor(() => expect(saveButton).toBeEnabled());

    vi.mocked(bridge.discardStorageSettings).mockResolvedValueOnce(result("cancelled", pending));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("status")).toHaveTextContent("Changes were not applied.");

    vi.mocked(bridge.saveStorageSettings).mockResolvedValueOnce(result("busy", pending));
    await user.click(saveButton);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pomegr is already updating storage settings. Wait for it to finish."));

    vi.mocked(bridge.saveStorageSettings).mockResolvedValueOnce(result("unavailable", pending));
    await user.click(saveButton);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Storage settings are unavailable in this desktop runtime."));

    vi.mocked(bridge.saveStorageSettings).mockRejectedValueOnce(new Error("C:\\Users\\secret\\storage.sqlite"));
    await user.click(saveButton);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pomegr could not complete that change. Try again."));
    expect(screen.queryByText(/C:\\Users|secret|\.sqlite/)).not.toBeInTheDocument();

    vi.mocked(bridge.saveStorageSettings).mockResolvedValueOnce(result("restarting", null));
    await user.click(saveButton);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pomegr is restarting with the new storage settings."));
  });
});
