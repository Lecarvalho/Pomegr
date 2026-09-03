/** Native desktop management only; never part of normalized monitor state. */
export type PhoneAccessState = {
  status: "off" | "starting" | "sharing" | "unavailable";
  reason: null | "network_unavailable" | "public_network" | "choose_network" | "network_changed" | "start_failed" | "settings_unavailable";
  autoStart: boolean;
  candidates: Array<{ id: string; label: string; address: string }>;
  selectedNetworkId: string | null;
  address: string | null;
  pairedClients: number;
};

export type PhonePairing = { url: string; expiresAt: string };

export type PhoneAccessBridge = {
  getPhoneAccessState(): Promise<PhoneAccessState | null>;
  setPhoneSharing(enabled: boolean, networkId?: string): Promise<PhoneAccessState | null>;
  setPhoneAutoStart(enabled: boolean): Promise<PhoneAccessState | null>;
  createPhonePairing(): Promise<PhonePairing | null>;
  onPhoneAccessChanged(callback: (state: PhoneAccessState) => void): () => void;
};
