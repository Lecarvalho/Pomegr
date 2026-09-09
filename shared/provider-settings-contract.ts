/**
 * Bounded desktop-only session-source settings. Folder paths and credential
 * details stay inside the native runtime.
 */
export const PROVIDER_FOLDER_KEYS = ["claudeConfigDir", "claudeProjectsDir", "codexHome"] as const;

export type ProviderFolderKey = (typeof PROVIDER_FOLDER_KEYS)[number];
export type ProviderFolderSelection = "default" | "environment" | "custom";
export type ProviderFolderAvailability = "available" | "unavailable";

export type ProviderSettingsState = {
  canSave: boolean;
  pendingChanges: boolean;
  folders: Record<ProviderFolderKey, {
    selection: ProviderFolderSelection;
    availability: ProviderFolderAvailability;
  }>;
};

export type ProviderSettingsResult = {
  status: "ready" | "cancelled" | "busy" | "unavailable" | "failed" | "restarting";
  state: ProviderSettingsState | null;
};

export type ProviderSettingsBridge = {
  getProviderSettings(): Promise<ProviderSettingsState | null>;
  chooseProviderFolder(key: ProviderFolderKey): Promise<ProviderSettingsResult>;
  resetProviderFolder(key: ProviderFolderKey): Promise<ProviderSettingsResult>;
  discardProviderSettings(): Promise<ProviderSettingsResult>;
  saveProviderSettings(): Promise<ProviderSettingsResult>;
};
