const CHANNEL = "pomegr:open-session-link";
const INVALID = Object.freeze({ ok: false, error: "invalid" });

/** Only an owner-clicked saved-history link reaches this trusted desktop channel. */
export function installSessionLinkIpc({ ipcMain, isTrustedEvent = () => false, openExternal } = {}) {
  ipcMain.removeHandler(CHANNEL);
  ipcMain.handle(CHANNEL, async (event, ...args) => {
    if (!isTrustedEvent(event) || args.length !== 1 || typeof args[0] !== "string" || args[0].length > 2048) return INVALID;
    const [value] = args;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.href !== value) return INVALID;
      await openExternal(value);
      return { ok: true };
    } catch { return INVALID; }
  });
  return () => ipcMain.removeHandler(CHANNEL);
}
