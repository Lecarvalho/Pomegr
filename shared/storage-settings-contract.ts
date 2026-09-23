/**
 * Bounded desktop-only storage retention settings. Values are fixed enums; the
 * monitor applies saved values on its next start and prune cycle. Browser and LAN
 * clients read the effective values from `/api/storage` and never write them.
 */
export const STORAGE_SETTING_KEYS = ["retentionDays", "storeMaxMb"] as const;

/** Desktop encoding: `0` means keep all (the monitor contract uses `null`). */
export const STORAGE_RETENTION_DAY_SETTINGS = [30, 90, 180, 365, 0] as const;
export const STORAGE_MAX_MB_SETTINGS = [250, 500, 1024, 2048] as const;

export type StorageSettingKey = (typeof STORAGE_SETTING_KEYS)[number];
export type StorageRetentionDaySetting = (typeof STORAGE_RETENTION_DAY_SETTINGS)[number];
export type StorageMaxMbSetting = (typeof STORAGE_MAX_MB_SETTINGS)[number];

export type StorageSettingValues = {
  retentionDays: StorageRetentionDaySetting;
  storeMaxMb: StorageMaxMbSetting;
};

export type StorageSettingsState = {
  canSave: boolean;
  pendingChanges: boolean;
  /** The draft shown in the controls: saved values plus uncommitted changes. */
  values: StorageSettingValues;
};

export type StorageSettingsResult = {
  status: "ready" | "cancelled" | "busy" | "unavailable" | "failed" | "restarting";
  state: StorageSettingsState | null;
};

export type StorageSettingsBridge = {
  getStorageSettings(): Promise<StorageSettingsState | null>;
  setStorageSetting<K extends StorageSettingKey>(key: K, value: StorageSettingValues[K]): Promise<StorageSettingsResult>;
  discardStorageSettings(): Promise<StorageSettingsResult>;
  saveStorageSettings(): Promise<StorageSettingsResult>;
};
