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

const ALLOWED_PROVIDER_STATUS_ORIGINS = Object.freeze([
  "https://status.claude.com",
  "https://status.openai.com",
]);
const POMEGR_GITHUB_PATH_PREFIX = "/Lecarvalho/pomegr";
const CODEX_CACHE_ISSUE_PATH = "/openai/codex/issues/35300";
const GITHUB_PULL_REQUEST_PATH = /^\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9]\d{0,9}$/;
const PROVIDER_STATUS_PATH = /^\/(?:incidents\/[A-Za-z0-9_-]{1,128}\/?)?$/;

// Web-only development routes. The desktop shell refuses to navigate to them even
// though they share the application origin; the client view also hides them.
export const DESKTOP_HIDDEN_PATHS = Object.freeze(["/design-system"]);

export function isDesktopHiddenPath(pathname) {
  if (typeof pathname !== "string") return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return true; }
  const normalized = decoded.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return DESKTOP_HIDDEN_PATHS.some((hidden) => normalized === hidden
    || normalized === `${hidden}.rsc`
    || normalized.startsWith(`${hidden}/`));
}

export function isAllowedExternalUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (ALLOWED_PROVIDER_STATUS_ORIGINS.includes(url.origin)) {
    return !url.search && !url.hash && PROVIDER_STATUS_PATH.test(url.pathname);
  }
  if (url.origin !== "https://github.com") return false;
  if (url.pathname === POMEGR_GITHUB_PATH_PREFIX || url.pathname.startsWith(`${POMEGR_GITHUB_PATH_PREFIX}/`)) return true;
  if (url.search) return false;
  const pathname = url.pathname.replace(/\/$/, "");
  return pathname === CODEX_CACHE_ISSUE_PATH || GITHUB_PULL_REQUEST_PATH.test(pathname);
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
    try {
      const url = new URL(value);
      return url.origin === expectedOrigin && !isDesktopHiddenPath(url.pathname);
    } catch { return false; }
  };
  const openAllowedExternal = (value) => {
    if (!isAllowedExternalUrl(value)) return;
    try { void Promise.resolve(openExternal(value)).catch(() => {}); } catch {}
  };
  const handleNavigation = (event, target) => {
    if (allowInternal(target)) return;
    event.preventDefault();
    openAllowedExternal(target);
  };
  const denyUnexpectedRedirect = (event, target) => {
    if (!allowInternal(target)) event.preventDefault();
  };
  webContents.on("will-navigate", handleNavigation);
  webContents.on("will-redirect", denyUnexpectedRedirect);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url);
    return { action: "deny" };
  });
}
