import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const PACKAGED_LEGAL_FILES = Object.freeze([
  "LICENSE",
  "NOTICE",
  "SOURCE.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
]);

export const EXTERNAL_LEGAL_FILES = Object.freeze([
  "legal/LICENSE",
  "legal/NOTICE",
  "legal/SOURCE.md",
  "legal/THIRD_PARTY_NOTICES.md",
  "legal/TRADEMARKS.md",
]);

export const EXTERNAL_RUNTIME_FILES = Object.freeze(["tray-icon.png"]);

export const PUBLIC_LEGAL_FILES = Object.freeze([
  "dist/client/legal/LICENSE.txt",
  "dist/client/legal/NOTICE.txt",
  "dist/client/legal/SOURCE.txt",
  "dist/client/legal/THIRD_PARTY_NOTICES.txt",
  "dist/client/legal/TRADEMARKS.txt",
]);

export const DESKTOP_RUNTIME_FILES = Object.freeze([
  "desktop/runtime/bounded-lifecycle.mjs",
  "desktop/runtime/artifact-privacy.mjs",
  "desktop/runtime/claude-auth.mjs",
  "desktop/runtime/claude-usage-setup.mjs",
  "desktop/runtime/desktop-behavior.mjs",
  "desktop/runtime/environment-policy.mjs",
  "desktop/runtime/lan-gateway.mjs",
  "desktop/runtime/lan-network.mjs",
  "desktop/runtime/lan-pairing-page.mjs",
  "desktop/runtime/lan-sharing.mjs",
  "desktop/runtime/main.mjs",
  "desktop/runtime/monitor-worker.mjs",
  "desktop/runtime/native-security.mjs",
  "desktop/runtime/notifications.mjs",
  "desktop/runtime/notification-delivery-store.mjs",
  "desktop/runtime/paths.mjs",
  "desktop/runtime/preload.cjs",
  "desktop/runtime/quiet-console.mjs",
  "desktop/runtime/report-save.mjs",
  "desktop/runtime/repository-inventory-action.mjs",
  "desktop/runtime/repository-plugin-action.mjs",
  "desktop/runtime/plugin-cli.mjs",
  "desktop/runtime/security-policy.mjs",
  "desktop/runtime/shell-stage.mjs",
  "desktop/runtime/settings.mjs",
  "desktop/runtime/provider-settings.mjs",
  "desktop/runtime/storage-settings.mjs",
  "desktop/runtime/shell-main.mjs",
  "desktop/runtime/shell-orchestrator.mjs",
  "desktop/runtime/startup-error.mjs",
  "desktop/runtime/updater.mjs",
  "desktop/runtime/utility-lifecycle.mjs",
  "desktop/workers/monitor-host.cjs",
  "desktop/workers/claude-statusline-bridge.cjs",
  "shared/local-auth.mjs",
  "shared/agent-query-transport.mjs",
  "shared/local-service.mjs",
  "shared/pomegr-paths.mjs",
  "shared/session-route.mjs",
  "shared/usage-notification.mjs",
  "server/web/server.mjs",
]);

export const BRAND_ASSET_FILES = Object.freeze([
  "assets/brand/pomegr-logo.png",
  "build/icon.png",
]);

const REQUIRED_APPLICATION_FILES = Object.freeze([
  ...PUBLIC_LEGAL_FILES,
  ...DESKTOP_RUNTIME_FILES,
  ...BRAND_ASSET_FILES,
  "dist/server/index.js",
  "package.json",
]);

const EXACT_APPLICATION_FILES = new Set([
  ...PACKAGED_LEGAL_FILES,
  "package.json",
  ...DESKTOP_RUNTIME_FILES,
  ...BRAND_ASSET_FILES,
]);

const APPLICATION_DIRECTORIES = new Set([
  "assets",
  "assets/brand",
  "build",
  "desktop",
  "desktop/runtime",
  "desktop/workers",
  "dist",
  "node_modules",
  "server",
  "server/web",
  "shared",
]);

const FORBIDDEN_SEGMENTS = new Set([
  ".claude",
  ".cache",
  ".codex",
  ".git",
  ".next",
  ".vinext",
  ".wrangler",
  "__tests__",
  "coverage",
  "fixtures",
  "outputs",
  "test",
  "tests",
  "private-data",
  "work",
]);

const PRIVATE_DATA_SEGMENTS = new Set([
  "auth",
  "credential",
  "credentials",
  "oauth",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

export function normalizeArtifactPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function expectedArtifactNames(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || "")) {
    throw new Error("DESKTOP_ARTIFACT_VERSION_INVALID");
  }
  return Object.freeze([
    `Pomegr-Setup-${version}-x64.exe`,
    `Pomegr-Portable-${version}-x64.exe`,
  ]);
}

export function expectedUpdateArtifactNames(version) {
  const match = String(version || "").match(/^\d+\.\d+\.\d+(?:-(beta)\.\d+)?$/);
  if (!match) {
    throw new Error("DESKTOP_ARTIFACT_VERSION_INVALID");
  }
  return Object.freeze([
    match[1] === "beta" ? "beta.yml" : "latest.yml",
    `Pomegr-Setup-${version}-x64.exe.blockmap`,
  ]);
}

export function isAllowedApplicationPath(value) {
  const filename = normalizeArtifactPath(value);
  return APPLICATION_DIRECTORIES.has(filename)
    || EXACT_APPLICATION_FILES.has(filename)
    || filename.startsWith("assets/brand/")
    || filename.startsWith("dist/")
    || filename.startsWith("node_modules/");
}

export function forbiddenArtifactPath(value) {
  const filename = normalizeArtifactPath(value);
  const segments = filename.toLowerCase().split("/");
  if (segments.some((segment) => segment.startsWith(".env"))) return true;
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return true;
  if (segments.some((segment) => PRIVATE_DATA_SEGMENTS.has(segment))) return true;
  const basename = segments.at(-1) || "";
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(basename)) return true;
  if (/^(?:auth|oauth|token|tokens|secret|secrets|credential|credentials|private-data)(?:[._-](?:data|cache|store|config|backup))?\.(?:json|ya?ml|toml|ini|txt|log|bak)$/i.test(basename)) return true;
  if (/(?:^|\/)(?:transcript)(?:[._-]|\/|$)/i.test(filename)) return true;
  if (/\.(?:jsonl|log|pem|pfx|p12|key|ts|tsx|cts|mts|tsbuildinfo|map)$/i.test(filename)) return true;
  return false;
}

export function assertPackagedApplicationFiles(paths) {
  const files = new Set(paths.map(normalizeArtifactPath).filter(Boolean));
  if (!files.size) throw new Error("DESKTOP_ARTIFACT_EMPTY");
  for (const filename of files) {
    if (!isAllowedApplicationPath(filename)) throw new Error("DESKTOP_ARTIFACT_NOT_ALLOWLISTED");
    if (forbiddenArtifactPath(filename)) throw new Error("DESKTOP_ARTIFACT_FORBIDDEN_PATH");
  }
  for (const required of REQUIRED_APPLICATION_FILES) {
    if (!files.has(required)) throw new Error("DESKTOP_ARTIFACT_REQUIRED_FILE_MISSING");
  }
  return Object.freeze({ fileCount: files.size });
}

export function dependencyNoticeKeys(content) {
  const keys = [];
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^\| ([^|]+?) \| ([^|]+?) \| [^|]+ \|$/);
    if (match && match[1].trim() !== "Package" && /^\d/.test(match[2].trim())) {
      keys.push(`${match[1].trim()}@${match[2].trim()}`);
    }
  }
  if (!keys.length) throw new Error("DESKTOP_DEPENDENCY_NOTICE_EMPTY");
  return [...new Set(keys)].sort();
}

export function isDependencyPackageManifest(value) {
  return /^node_modules\/(?:@[^/]+\/[^/]+|[^/]+)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))*\/package\.json$/.test(normalizeArtifactPath(value));
}

export async function recursiveFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const child of await recursiveFiles(absolute)) files.push(`${entry.name}/${child}`);
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

export async function assertNonemptyFile(filename, code = "DESKTOP_ARTIFACT_MISSING") {
  let details;
  try { details = await stat(filename); } catch { throw new Error(code); }
  if (!details.isFile() || details.size === 0) throw new Error(code);
  return details.size;
}
