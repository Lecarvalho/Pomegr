import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { GET } from "../../app/api/client-access/route";
import { CopyTranscriptButton } from "../../app/components/CopyTranscriptButton";
import { ClientAccessProvider, PhoneAccessExpiredNotice, useClientAccess } from "../../app/hooks/ClientAccessContext";
import { DisplayPreferencesProvider } from "../../app/hooks/DisplayPreferencesContext";
import { SettingsPage } from "../../app/settings/SettingsPage";
import type { PhoneAccessState } from "../../shared/lan-sharing-contract";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn() } }));

const offState: PhoneAccessState = {
  status: "off",
  reason: "choose_network",
  autoStart: false,
  candidates: [
    { id: "home", label: "Home Wi-Fi", address: "192.168.1.20" },
    { id: "studio", label: "Studio Ethernet", address: "10.0.0.5" },
  ],
  selectedNetworkId: null,
  address: null,
  pairedClients: 0,
};

function installDesktopBridge(overrides: Record<string, unknown> = {}) {
  const bridge = {
    getDesktopState: vi.fn(async () => null),
    onDesktopStateChanged: vi.fn(() => () => {}),
    getPhoneAccessState: vi.fn(async () => offState),
    setPhoneSharing: vi.fn(async (enabled: boolean, networkId?: string) => enabled
      ? { ...offState, status: "sharing" as const, reason: null, selectedNetworkId: networkId || null, address: "192.168.1.20:3003", pairedClients: 2 }
      : offState),
    setPhoneAutoStart: vi.fn(async (enabled: boolean) => ({ ...offState, autoStart: enabled })),
    createPhonePairing: vi.fn(async () => ({ url: "http://192.168.1.20:3003/__pomegr/pair?token=opaque", expiresAt: new Date(Date.now() + 60_000).toISOString() })),
    onPhoneAccessChanged: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as Window & { pomegrDesktop?: typeof bridge }).pomegrDesktop = bridge;
  return bridge;
}

function renderSettings() {
  return render(<DisplayPreferencesProvider><SettingsPage /></DisplayPreferencesProvider>);
}

async function openPhoneAccess() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "Phone access" }));
  return user;
}

function ExpireAccess() {
  const { markAccessExpired, refreshAccess } = useClientAccess();
  return <><button type="button" onClick={() => void refreshAccess()}>Refresh access</button><button type="button" onClick={markAccessExpired}>Expire access</button></>;
}

afterEach(() => {
  delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("phone access", () => {
  it("keeps Phone access out of ordinary browser settings", () => {
    renderSettings();
    expect(screen.queryByRole("tab", { name: "Phone access" })).not.toBeInTheDocument();
  });

  it("requires a private-network choice before starting, then creates and clears an expiring pairing code", async () => {
    const bridge = installDesktopBridge();
    (QRCode.toDataURL as unknown as { mockResolvedValue: (value: string) => void }).mockResolvedValue("data:image/png;base64,quiet-zone");
    renderSettings();
    const user = await openPhoneAccess();

    const network = await screen.findByRole("combobox", { name: "Private network" });
    expect(screen.getByRole("button", { name: "Enable phone access" })).toBeDisabled();
    await user.selectOptions(network, "home");
    await user.click(screen.getByRole("button", { name: "Enable phone access" }));
    await waitFor(() => expect(bridge.setPhoneSharing).toHaveBeenCalledWith(true, "home"));
    expect(await screen.findByText("Sharing started")).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === "2 paired phones")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create pairing code" }));
    expect(await screen.findByRole("img", { name: /Scan this expiring code/ })).toHaveAttribute("src", "data:image/png;base64,quiet-zone");
    expect(QRCode.toDataURL).toHaveBeenCalledWith(expect.stringContaining("/__pomegr/pair?token=opaque"), expect.objectContaining({ margin: 4, color: { dark: "#000000", light: "#ffffff" } }));

    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(bridge.setPhoneSharing).toHaveBeenLastCalledWith(false, undefined));
    expect(screen.queryByRole("img", { name: /Scan this expiring code/ })).not.toBeInTheDocument();
  });

  it("persists automatic private-network startup separately from starting phone access", async () => {
    const bridge = installDesktopBridge({ getPhoneAccessState: vi.fn(async () => ({ ...offState, candidates: [], reason: null })) });
    renderSettings();
    const user = await openPhoneAccess();
    const autoStart = await screen.findByRole("switch", { name: /Start on a private network/ });
    await user.click(autoStart);
    await waitFor(() => expect(bridge.setPhoneAutoStart).toHaveBeenCalledWith(true));
    expect(bridge.setPhoneSharing).not.toHaveBeenCalled();
  });

  it("explains unavailable phone sharing without exposing native details", async () => {
    const bridge = installDesktopBridge({ getPhoneAccessState: vi.fn(async () => ({ ...offState, status: "unavailable", reason: "network_unavailable" })) });
    renderSettings();
    const user = await openPhoneAccess();
    expect(await screen.findByText("Pomegr could not find a private network to share on.")).toBeInTheDocument();
    expect(screen.getByText(/uses unencrypted HTTP on the selected trusted private network/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh networks" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Refresh networks" }));
    await waitFor(() => expect(bridge.getPhoneAccessState).toHaveBeenCalledTimes(2));
    await user.selectOptions(screen.getByRole("combobox", { name: "Private network" }), "home");
    await user.click(screen.getByRole("button", { name: "Retry phone access" }));
    await waitFor(() => expect(bridge.setPhoneSharing).toHaveBeenCalledWith(true, "home"));
  });

  it("explains how to change a Windows Public network profile", async () => {
    installDesktopBridge({ getPhoneAccessState: vi.fn(async () => ({ ...offState, status: "unavailable", candidates: [], reason: "public_network" })) });
    renderSettings();
    await openPhoneAccess();
    expect(await screen.findByText("Windows classifies your connected network as Public.")).toBeInTheDocument();
    expect(screen.getByText(/change Network profile type to Private/i)).toBeInTheDocument();
  });

  it("drops a previous network choice when retrying on a different available network", async () => {
    let changed: ((next: PhoneAccessState) => void) | undefined;
    const bridge = installDesktopBridge({
      onPhoneAccessChanged: vi.fn((callback: (next: PhoneAccessState) => void) => {
        changed = callback;
        return () => {};
      }),
    });
    renderSettings();
    const user = await openPhoneAccess();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Private network" }), "home");
    await user.click(screen.getByRole("button", { name: "Enable phone access" }));
    expect(await screen.findByText("Sharing started")).toBeInTheDocument();
    await act(async () => changed?.({
      ...offState, status: "unavailable", reason: "network_changed",
      candidates: [offState.candidates[1]],
    }));
    expect(screen.queryByRole("combobox", { name: "Private network" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry phone access" }));
    await waitFor(() => expect(bridge.setPhoneSharing).toHaveBeenLastCalledWith(true, undefined));
  });

  it("does not restore a pairing code when sharing stops while its QR image is rendering", async () => {
    let phoneAccessChanged: ((next: PhoneAccessState | null) => void) | undefined;
    let resolveQr: ((image: string) => void) | undefined;
    const sharingState: PhoneAccessState = { ...offState, status: "sharing", reason: null, selectedNetworkId: "home", address: "192.168.1.20:3003" };
    const bridge = installDesktopBridge({
      getPhoneAccessState: vi.fn(async () => sharingState),
      onPhoneAccessChanged: vi.fn((callback: (next: PhoneAccessState | null) => void) => {
        phoneAccessChanged = callback;
        return () => {};
      }),
    });
    (QRCode.toDataURL as unknown as { mockImplementation: (callback: () => Promise<string>) => void }).mockImplementation(() => new Promise((resolve) => { resolveQr = resolve; }));
    renderSettings();
    const user = await openPhoneAccess();
    expect(await screen.findByText("Sharing started")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create pairing code" }));
    await waitFor(() => expect(bridge.createPhonePairing).toHaveBeenCalledTimes(1));

    phoneAccessChanged?.(offState);
    resolveQr?.("data:image/png;base64,stale");

    await waitFor(() => expect(screen.getByText("Phone access is off")).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: /Scan this expiring code/ })).not.toBeInTheDocument();
  });
});

describe("client access gate", () => {
  it("serves the local capability with no-store caching", async () => {
    const response = GET();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ mode: "local", canCopyTranscriptPath: true });
  });

  it("hides transcript copying until local capability resolves", async () => {
    const { rerender } = render(<CopyTranscriptButton sessionId="codex:session" agentId="agent" agentLabel="Builder" />);
    expect(screen.queryByRole("button", { name: /Copy transcript path/ })).not.toBeInTheDocument();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ mode: "local", canCopyTranscriptPath: true }), { status: 200 })));
    rerender(<ClientAccessProvider><CopyTranscriptButton sessionId="codex:session" agentId="agent" agentLabel="Builder" /></ClientAccessProvider>);
    expect(await screen.findByRole("button", { name: "Copy transcript path for Builder" })).toBeInTheDocument();
  });

  it("offers a pairing recovery path only after a known LAN access session expires", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ mode: "lan", canCopyTranscriptPath: false }), { status: 200 })));
    const user = userEvent.setup();
    render(<ClientAccessProvider><ExpireAccess /><PhoneAccessExpiredNotice /></ClientAccessProvider>);
    await user.click(screen.getByRole("button", { name: "Refresh access" }));
    await user.click(screen.getByRole("button", { name: "Expire access" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Phone access expired");
    expect(screen.getByRole("link", { name: "Scan a new code on your computer" })).toHaveAttribute("href", "/__pomegr/pair");
  });
});
