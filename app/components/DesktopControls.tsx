export type DesktopState = {
  applicationVersion?: string | null;
  paused: boolean;
  launchAtLogin: boolean;
  launchAtLoginAvailable: boolean;
  closeBehavior: "ask" | "tray" | "quit";
  notifications: boolean;
  notificationQuietUntil: string | null;
  displayPreferences: {
    estimatedCost: boolean;
  };
  update?: {
    status: "disabled" | "idle" | "checking" | "downloading" | "ready" | "installing" | "failed";
    version: string | null;
    lastCheckedAt?: string | null;
  };
};
