import { readFileSync } from "node:fs";
import path from "node:path";

export const VINEXT_LAN_COMPAT_VERSION = "0.0.50";
export const VINEXT_LAN_COMPAT_MODULE = "node_modules/vinext/dist/server/app-rsc-cache-busting.js";

const SHA256_FUNCTION = [
  "async function sha256CacheBustingHash(input) {",
  "\tconst digest = await globalThis.crypto.subtle.digest(\"SHA-256\", textEncoder.encode(input));",
  "\treturn encodeBase64Url(new Uint8Array(digest).subarray(0, CACHE_BUSTING_DIGEST_BYTES));",
  "}",
].join("\n");

const LAN_COMPAT_FUNCTION = [
  "async function sha256CacheBustingHash(input) {",
  "\tif (!globalThis.crypto?.subtle) return fnv1a64(input);",
  "\tconst digest = await globalThis.crypto.subtle.digest(\"SHA-256\", textEncoder.encode(input));",
  "\treturn encodeBase64Url(new Uint8Array(digest).subarray(0, CACHE_BUSTING_DIGEST_BYTES));",
  "}",
].join("\n");

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizedId(value) {
  return typeof value === "string" ? value.split("?", 1)[0].replaceAll("\\", "/") : "";
}

export function isVinextLanCompatibilityModule(id) {
  return normalizedId(id).endsWith(`/${VINEXT_LAN_COMPAT_MODULE}`);
}

export function transformVinextLanCompatibility(code, id) {
  if (!isVinextLanCompatibilityModule(id)) return null;
  if (typeof code !== "string" || !code.includes('import { fnv1a64 } from "../utils/hash.js";')) {
    throw fixedError("VINEXT_LAN_COMPAT_SIGNATURE_DRIFT");
  }
  const occurrences = code.split(SHA256_FUNCTION).length - 1;
  if (occurrences !== 1) throw fixedError("VINEXT_LAN_COMPAT_SIGNATURE_DRIFT");
  return code.replace(SHA256_FUNCTION, LAN_COMPAT_FUNCTION);
}

export function verifyVinextLanCompatibility({ root = process.cwd(), readFileSyncFn = readFileSync } = {}) {
  const modulePath = path.join(root, VINEXT_LAN_COMPAT_MODULE);
  const manifestPath = path.join(root, "node_modules", "vinext", "package.json");
  let manifest;
  let source;
  try {
    manifest = JSON.parse(readFileSyncFn(manifestPath, "utf8"));
    source = readFileSyncFn(modulePath, "utf8");
  } catch {
    throw fixedError("VINEXT_LAN_COMPAT_MODULE_MISSING");
  }
  if (manifest?.version !== VINEXT_LAN_COMPAT_VERSION) throw fixedError("VINEXT_LAN_COMPAT_VERSION_DRIFT");
  if (!transformVinextLanCompatibility(source, modulePath)) throw fixedError("VINEXT_LAN_COMPAT_SIGNATURE_DRIFT");
  return Object.freeze({ modulePath, version: manifest.version });
}

/** @returns {import("vite").Plugin} */
export function vinextLanCompatibilityPlugin() {
  return Object.freeze({
    name: "pomegr-vinext-lan-compat",
    enforce: "pre",
    configResolved(config) {
      verifyVinextLanCompatibility({ root: config.root });
    },
    transform(code, id) {
      const transformed = transformVinextLanCompatibility(code, id);
      return transformed === null ? null : { code: transformed, map: null };
    },
  });
}
