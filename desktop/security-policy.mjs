import path from "node:path";

import { DESKTOP_AUTH_HEADER, requireDesktopToken } from "../shared/local-auth.mjs";

export const DESKTOP_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

const ALLOWED_EXTERNAL_PREFIXES = Object.freeze([
  "https://github.com/Lecarvalho/pomegr",
]);

export function isAllowedExternalUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return ALLOWED_EXTERNAL_PREFIXES.some((prefix) => {
    const allowed = new URL(prefix);
    return url.origin === allowed.origin
      && (url.pathname === allowed.pathname || url.pathname.startsWith(`${allowed.pathname}/`));
  });
}

export function secureBrowserWindowOptions({ preloadPath, browserSession, windowState }) {
  if (!path.isAbsolute(preloadPath)) throw new Error("DESKTOP_PRELOAD_PATH_INVALID");
  const restored = windowState && typeof windowState === "object" ? windowState : {};
  return {
    width: restored.width || 1280,
    height: restored.height || 800,
    ...(Number.isInteger(restored.x) ? { x: restored.x } : {}),
    ...(Number.isInteger(restored.y) ? { y: restored.y } : {}),
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
    },
  };
}

export function installSessionSecurity(browserSession, { webOrigin, authorizationToken }) {
  const expectedOrigin = new URL(webOrigin).origin;
  const token = requireDesktopToken(authorizationToken);
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  browserSession.setDevicePermissionHandler?.(() => false);
  browserSession.on("will-download", (event) => event.preventDefault());
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (new URL(details.url).origin === expectedOrigin) headers[DESKTOP_AUTH_HEADER] = token;
    else delete headers[DESKTOP_AUTH_HEADER];
    callback({ requestHeaders: headers });
  });
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    if (new URL(details.url).origin !== expectedOrigin) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [DESKTOP_CSP],
        "Cross-Origin-Opener-Policy": ["same-origin"],
        "Referrer-Policy": ["no-referrer"],
        "X-Content-Type-Options": ["nosniff"],
        "X-Frame-Options": ["DENY"],
      },
    });
  });
}

export function installWebContentsSecurity(webContents, { webOrigin, openExternal }) {
  const expectedOrigin = new URL(webOrigin).origin;
  const allowInternal = (value) => {
    try { return new URL(value).origin === expectedOrigin; } catch { return false; }
  };
  const denyUnexpectedNavigation = (event, target) => {
    if (!allowInternal(target)) event.preventDefault();
  };
  webContents.on("will-navigate", denyUnexpectedNavigation);
  webContents.on("will-redirect", denyUnexpectedNavigation);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void openExternal(url).catch(() => {});
    return { action: "deny" };
  });
}
