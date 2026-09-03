import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  VINEXT_LAN_COMPAT_MODULE,
  VINEXT_LAN_COMPAT_VERSION,
  transformVinextLanCompatibility,
  verifyVinextLanCompatibility,
  vinextLanCompatibilityPlugin,
} from "../scripts/vinext-lan-compat.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, VINEXT_LAN_COMPAT_MODULE);
const MODULE_DIRECTORY = path.dirname(MODULE_PATH);
const [{ fnv1a64 }, originalVinextCacheBusting] = await Promise.all([
  import(pathToFileURL(path.join(MODULE_DIRECTORY, "..", "utils", "hash.js")).href),
  import(pathToFileURL(MODULE_PATH).href),
]);

async function loadTransformedModule(source) {
  const rewritten = source
    .replace('from "./headers.js"', `from "${pathToFileURL(path.join(MODULE_DIRECTORY, "headers.js")).href}"`)
    .replace('from "../utils/hash.js"', `from "${pathToFileURL(path.join(MODULE_DIRECTORY, "..", "utils", "hash.js")).href}"`)
    .replace('from "./app-rsc-render-mode.js"', `from "${pathToFileURL(path.join(MODULE_DIRECTORY, "app-rsc-render-mode.js")).href}"`);
  return import(`data:text/javascript;base64,${Buffer.from(rewritten, "utf8").toString("base64")}`);
}

async function withoutWebCrypto(callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try { return await callback(); } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
}

test("Vinext LAN transform is pinned to the installed module and exact SHA helper", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  const transformed = transformVinextLanCompatibility(source, MODULE_PATH);
  assert.match(transformed, /if \(!globalThis\.crypto\?\.subtle\) return fnv1a64\(input\);/);
  assert.equal(transformVinextLanCompatibility(source, `${MODULE_PATH}?v=1`).includes("crypto?.subtle"), true);
  assert.equal(transformVinextLanCompatibility(source, "app-rsc-cache-busting.js"), null);
  assert.throws(
    () => transformVinextLanCompatibility(source.replace("digest).subarray(0, CACHE_BUSTING_DIGEST_BYTES)", "digest).subarray(0, 8)"), MODULE_PATH),
    (error) => error.code === "VINEXT_LAN_COMPAT_SIGNATURE_DRIFT",
  );
  assert.deepEqual(verifyVinextLanCompatibility({ root: ROOT }), { modulePath: MODULE_PATH, version: VINEXT_LAN_COMPAT_VERSION });
  assert.throws(
    () => verifyVinextLanCompatibility({
      root: ROOT,
      readFileSyncFn(filename) {
        if (filename.endsWith("package.json")) return JSON.stringify({ version: "0.0.51" });
        return source;
      },
    }),
    (error) => error.code === "VINEXT_LAN_COMPAT_VERSION_DRIFT",
  );
  const plugin = vinextLanCompatibilityPlugin();
  assert.equal(plugin.name, "pomegr-vinext-lan-compat");
  assert.equal(plugin.enforce, "pre");
});

test("Vinext LAN transform uses the accepted legacy variant hash only without Web Crypto", async () => {
  const source = transformVinextLanCompatibility(await readFile(MODULE_PATH, "utf8"), MODULE_PATH);
  const headers = new Headers({ "Next-Router-State-Tree": "tree", "X-Vinext-Mounted-Slots": "main" });
  const legacyHash = fnv1a64("0,0,tree,0,0,main,0");
  const insecureModule = await withoutWebCrypto(() => loadTransformedModule(source));
  const insecureUrl = await withoutWebCrypto(() => insecureModule.createRscRequestUrl("/settings?tab=lan", headers));
  assert.equal(new URL(insecureUrl, "http://vinext.local").searchParams.get("_rsc"), legacyHash);

  const accepted = await originalVinextCacheBusting.resolveInvalidRscCacheBustingRequest({
    isRscRequest: true,
    request: new Request(`https://pomegr.local${insecureUrl}`, { headers }),
  });
  assert.equal(accepted, null, "the unmodified Vinext server accepts the legacy cache variant");
});

test("Vinext LAN transform keeps the SHA cache variant when Web Crypto is available", async () => {
  const source = transformVinextLanCompatibility(await readFile(MODULE_PATH, "utf8"), MODULE_PATH);
  const transformedModule = await loadTransformedModule(source);
  const headers = new Headers({ "Next-Router-State-Tree": "tree", "X-Vinext-Mounted-Slots": "main" });
  const [transformedUrl, originalUrl] = await Promise.all([
    transformedModule.createRscRequestUrl("/settings?tab=lan", headers),
    originalVinextCacheBusting.createRscRequestUrl("/settings?tab=lan", headers),
  ]);
  assert.equal(transformedUrl, originalUrl);
  assert.notEqual(new URL(transformedUrl, "http://vinext.local").searchParams.get("_rsc"), fnv1a64("0,0,tree,0,0,main,0"));
});
