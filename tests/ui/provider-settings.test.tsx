import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsBridge, ProviderSettingsResult, ProviderSettingsState } from "../../shared/provider-settings-contract";
import { SettingsPage } from "../../app/settings/SettingsPage";

const folderPaths = { claudeConfigDir: "C:\\Profiles\\.claude", claudeProjectsDir: "C:\\Profiles\\.claude\\projects", codexHome: "C:\\Profiles\\.codex" };

const state: ProviderSettingsState = {
  canSave: true,
  pendingChanges: true,
  folders: {
    claudeConfigDir: { selection: "custom", availability: "available" },
    claudeProjectsDir: { selection: "environment", availability: "unavailable" },
    codexHome: { selection: "default", availability: "available" },
  },
};

function result(status: ProviderSettingsResult["status"], next: ProviderSettingsState | null = state): ProviderSettingsResult {
  return { status, state: next };
}

function setupDesktop(next = state) {
  const bridge: ProviderSettingsBridge = {
    getProviderSettings: vi.fn(async () => next),
    chooseProviderFolder: vi.fn(async () => result("ready")),
    resetProviderFolder: vi.fn(async () => result("ready")),
    discardProviderSettings: vi.fn(async () => result("ready", { ...state, canSave: false, pendingChanges: false })),
    saveProviderSettings: vi.fn(async () => result("restarting", null)),
  };
  Object.defineProperty(window, "pomegrDesktop", { configurable: true, value: bridge });
  return bridge;
}

afterEach(() => {
  Reflect.deleteProperty(window, "pomegrDesktop");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Provider Settings", () => {
  it("shows effective folders read-only in the local production browser with no mutation controls", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchFolders = vi.fn(async () => Response.json({ folders: folderPaths }));
    vi.stubGlobal("fetch", fetchFolders);
    render(<SettingsPage initialSection="providers" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Providers" });
    expect(screen.getByText(/Folder paths are read-only in the browser/)).toBeInTheDocument();
    const pathField = screen.getByRole("textbox", { name: "Configuration folder" });
    expect(pathField).toHaveValue(folderPaths.claudeConfigDir);
    expect(pathField).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "Home folder" })).toHaveValue(folderPaths.codexHome);
    expect(screen.queryByRole("button", { name: "Save and restart Pomegr" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose folder…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use default" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    await user.click(screen.getByText("Advanced"));
    expect(screen.getByRole("textbox", { name: "Session folder" })).toHaveValue(folderPaths.claudeProjectsDir);
    await user.type(pathField, "changed");
    expect(pathField).toHaveValue(folderPaths.claudeConfigDir);
    expect(fetchFolders).toHaveBeenCalledExactlyOnceWith("/api/provider-folders", { cache: "no-store", credentials: "same-origin" });
    expect(window).not.toHaveProperty("pomegrDesktop");
  });

  it("prefers the real native bridge and leaves native actions intact", async () => {
    const fetchFolders = vi.fn();
    vi.stubGlobal("fetch", fetchFolders);
    const bridge = setupDesktop();
    render(<SettingsPage initialSection="providers" />);
    await screen.findByRole("heading", { name: "Providers" });
    expect(bridge.getProviderSettings).toHaveBeenCalled();
    expect(screen.queryByText("Web preview.")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Configuration folder" })).not.toBeInTheDocument();
    expect(fetchFolders).not.toHaveBeenCalled();
  });

  it("shows unavailable paths honestly and recovers from a failed read", async () => {
    const fetchFolders = vi.fn().mockRejectedValueOnce(new Error("PRIVATE_NATIVE_DETAILS"))
      .mockResolvedValueOnce(Response.json({ folders: { ...folderPaths, codexHome: null } }));
    vi.stubGlobal("fetch", fetchFolders);
    render(<SettingsPage initialSection="providers" />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("status")).not.toHaveTextContent("PRIVATE_NATIVE_DETAILS");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("textbox", { name: "Home folder" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Home folder" })).toHaveAttribute("placeholder", "Path unavailable");
  });

  it.each(["192.168.1.10", "workstation", "workstation.local"])("shows authorized read-only folders through %s", async (host) => {
    vi.stubGlobal("location", new URL(`http://${host}:3003/settings`));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ folders: folderPaths })));
    render(<SettingsPage initialSection="providers" />);
    expect(screen.getByRole("tab", { name: "Providers" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Configuration folder" })).toHaveValue(folderPaths.claudeConfigDir);
    expect(screen.getByRole("textbox", { name: "Configuration folder" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Choose folder…" })).not.toBeInTheDocument();
  });

  it.each([401, 403, 404])("explains paired LAN access when a browser read is denied with %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    render(<SettingsPage initialSection="providers" />);
    expect(screen.getByRole("tab", { name: "Providers" })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Use paired LAN access to view provider folders.");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows bounded folder state and only opens a native picker after an explicit choice", async () => {
    const bridge = setupDesktop();
    render(<SettingsPage initialSection="providers" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Providers" });
    expect(screen.getByText("Custom folder · Available")).toBeInTheDocument();
    const advanced = screen.getByText("Advanced").closest("details");
    expect(advanced).not.toHaveAttribute("open");
    await user.click(screen.getByText("Advanced"));
    expect(advanced).toHaveAttribute("open");
    expect(screen.getAllByRole("button", { name: "Use default" })[1]).toBeDisabled();
    expect(screen.getByText("Default folder · Available")).toBeInTheDocument();
    expect(bridge.chooseProviderFolder).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: "Choose folder…" })[0]);
    expect(bridge.chooseProviderFolder).toHaveBeenCalledExactlyOnceWith("claudeConfigDir");
    expect(screen.getByRole("status")).toHaveTextContent("Folder selection updated.");
  });

  it("keeps changes in the native draft until save and restarts only through the explicit save action", async () => {
    const bridge = setupDesktop();
    render(<SettingsPage initialSection="providers" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Providers" });
    expect(bridge.saveProviderSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save and restart Pomegr" }));
    expect(bridge.saveProviderSettings).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole("status")).toHaveTextContent("Pomegr is restarting with the selected session sources.");
  });

  it("handles cancelled, busy, and failed native actions without exposing native details", async () => {
    const bridge = setupDesktop();
    vi.mocked(bridge.chooseProviderFolder).mockResolvedValueOnce(result("cancelled"));
    vi.mocked(bridge.resetProviderFolder).mockResolvedValueOnce(result("busy"));
    vi.mocked(bridge.discardProviderSettings).mockRejectedValueOnce(new Error("C:\\Users\\secret\\.claude"));
    render(<SettingsPage initialSection="providers" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Providers" });
    await user.click(screen.getAllByRole("button", { name: "Choose folder…" })[0]);
    expect(screen.getByRole("status")).toHaveTextContent("No folder was selected.");
    await user.click(screen.getAllByRole("button", { name: "Use default" })[0]);
    expect(screen.getByRole("status")).toHaveTextContent("already updating session sources");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pomegr could not complete that change. Try again."));
    expect(screen.queryByText(/C:\\Users|secret|\.claude/)).not.toBeInTheDocument();
  });

  it("does not let Settings Restore defaults reset provider source drafts", async () => {
    const bridge = setupDesktop();
    render(<SettingsPage initialSection="providers" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Providers" });
    await user.click(screen.getByRole("button", { name: "Restore defaults" }));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.resetProviderFolder).not.toHaveBeenCalled();
    expect(bridge.discardProviderSettings).not.toHaveBeenCalled();
  });

  it("recovers with Retry when the initial native state read fails", async () => {
    const bridge = setupDesktop();
    vi.mocked(bridge.getProviderSettings).mockRejectedValueOnce(new Error("native directory details"));
    render(<SettingsPage initialSection="providers" />);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("status")).toHaveTextContent("Provider folders are unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Providers" });
    expect(bridge.getProviderSettings).toHaveBeenCalledTimes(2);
  });

  it("labels a cancelled save as unapplied changes", async () => {
    const bridge = setupDesktop();
    vi.mocked(bridge.saveProviderSettings).mockResolvedValueOnce(result("cancelled"));
    render(<SettingsPage initialSection="providers" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Providers" });
    await user.click(screen.getByRole("button", { name: "Save and restart Pomegr" }));
    expect(screen.getByRole("status")).toHaveTextContent("Changes were not applied.");
  });

  it("disables folder actions when the native controller cannot save", async () => {
    setupDesktop({ ...state, canSave: false });
    render(<SettingsPage initialSection="providers" />);
    await screen.findByRole("heading", { name: "Providers" });
    expect(screen.getAllByRole("button", { name: "Choose folder…" })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Use default" })[0]).toBeDisabled();
  });

  it("reserves the Saving label for the save action", async () => {
    const bridge = setupDesktop();
    let finish!: (next: ProviderSettingsResult) => void;
    vi.mocked(bridge.chooseProviderFolder).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<SettingsPage initialSection="providers" />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Providers" });
    await user.click(screen.getAllByRole("button", { name: "Choose folder…" })[0]);
    expect(screen.getByRole("button", { name: "Save and restart Pomegr" })).toBeDisabled();
    await act(async () => finish(result("ready")));
    expect(screen.getByRole("button", { name: "Save and restart Pomegr" })).toBeEnabled();
  });
});
