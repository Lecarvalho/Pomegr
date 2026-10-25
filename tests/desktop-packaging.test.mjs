import assert from "node:assert/strict";
import path from "node:path";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  PUBLIC_LEGAL_FILES,
  DESKTOP_RUNTIME_FILES,
  BRAND_ASSET_FILES,
  assertPackagedApplicationFiles,
  dependencyNoticeKeys,
  expectedArtifactNames,
  expectedUpdateArtifactNames,
  forbiddenArtifactPath,
  isAllowedApplicationPath,
  isDependencyPackageManifest,
} from "../desktop/packaging/artifact-policy.mjs";
import { assertBuiltLegalNotices, generateLegalNotices, productionDependencyNotices, renderThirdPartyNotices } from "../desktop/packaging/legal-notices.mjs";
import { WORKER_BUNDLE_FILES } from "../desktop/packaging/asar-policy.mjs";
import { POMEGR_DT_08_PACKAGING_SCOPE, assertPomegrDt08PackagingScope } from "../desktop/packaging/pomegr-dt-08-scope.mjs";

const REQUIRED_FILES = [
  ...PUBLIC_LEGAL_FILES,
  ...DESKTOP_RUNTIME_FILES,
  ...BRAND_ASSET_FILES,
  "dist/server/index.js",
  "package.json",
];

test("desktop preparation rejects legal files regenerated after a Windows web build", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "pomegr-legal-order-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: { "": {} } }));
  for (const name of ["LICENSE", "NOTICE", "SOURCE.md", "TRADEMARKS.md"]) {
    await writeFile(path.join(root, name), `${name}\r\nfixture text\r\n`);
  }
  await generateLegalNotices(root);
  const publicRoot = path.join(root, "public", "legal");
  const builtRoot = path.join(root, "dist", "client", "legal");
  await mkdir(builtRoot, { recursive: true });
  await cp(publicRoot, builtRoot, { recursive: true });
  const builtLicense = path.join(builtRoot, "LICENSE.txt");
  const license = await readFile(builtLicense, "utf8");
  // A fresh Windows checkout was copied to dist before legal generation normalized it.
  await writeFile(builtLicense, license.replaceAll("\n", "\r\n"));
  await assert.rejects(assertBuiltLegalNotices(root), /DESKTOP_BUILD_LEGAL_CONTENT_MISMATCH/);
  await cp(publicRoot, builtRoot, { recursive: true });
  await assert.doesNotReject(assertBuiltLegalNotices(root));
  await writeFile(builtLicense, license.replace("fixture", "changed"));
  await assert.rejects(assertBuiltLegalNotices(root), /DESKTOP_BUILD_LEGAL_CONTENT_MISMATCH/);
});

test("electron-builder includes every required desktop runtime module", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packagedFiles = new Set(packageJson.build.files);
  const missing = DESKTOP_RUNTIME_FILES.filter((filename) => !packagedFiles.has(filename));
  assert.deepEqual(missing, [], "Required runtime modules must be included in electron-builder's file list");
});

test("the embedded terminal bridge and pinned renderer dependencies ship with their notices", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const bridge = "desktop/runtime/terminal.mjs";
  assert.ok(DESKTOP_RUNTIME_FILES.includes(bridge));
  assert.ok(packageJson.build.files.includes(bridge));
  const notices = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  for (const name of ["@fontsource-variable/inter", "@fontsource-variable/cascadia-mono"]) {
    assert.equal(packageJson.dependencies[name], "5.3.0");
    assert.equal(lock.packages[`node_modules/${name}`].version, "5.3.0");
    assert.ok(notices.includes(`| ${name} | 5.3.0 | OFL-1.1 |`));
  }
  for (const [name, version] of [["@xterm/xterm", "6.0.0"], ["@xterm/addon-fit", "0.11.0"], ["react-markdown", "10.1.0"], ["remark-gfm", "4.0.1"]]) {
    assert.equal(packageJson.dependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.ok(notices.includes(`| ${name} | ${version} | MIT |`));
  }
});

test("the agent chat's seven runtime files and its MCP worker are packaged, and its MCP sources are not shipped as modules", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packaged = new Set(packageJson.build.files);
  const runtimeFiles = ["agent-chat.mjs", "agent-chat-images.mjs", "agent-chat-prompt.mjs", "agent-chat-proposal.mjs", "agent-chat-runner.mjs", "agent-chat-store.mjs", "agent-chat-workflow.mjs"].map((name) => `desktop/runtime/${name}`);
  const worker = "desktop/workers/agent-chat-mcp.cjs";
  for (const file of [...runtimeFiles, worker]) {
    assert.ok(DESKTOP_RUNTIME_FILES.includes(file), `${file} is in the runtime allowlist`);
    assert.ok(packaged.has(file), `${file} is in electron-builder's file list`);
    assert.equal(isAllowedApplicationPath(file), true, `${file} is an allowed application path`);
    assert.equal(forbiddenArtifactPath(file), false, `${file} is not a forbidden artifact path`);
  }
  assert.ok(WORKER_BUNDLE_FILES.includes(worker), "the MCP worker is unpacked with the other worker bundles");
  assert.deepEqual(WORKER_BUNDLE_FILES.filter((file) => file.includes("agent-chat")), [worker]);
  assert.equal(DESKTOP_RUNTIME_FILES.some((file) => file.startsWith("mcp/")), false, "the MCP sources are bundled into the worker, not packaged");
  assert.equal(DESKTOP_RUNTIME_FILES.filter((file) => file.includes("agent-chat")).length, 8);
  assert.doesNotThrow(() => assertPackagedApplicationFiles([...REQUIRED_FILES]));
});

test("packaged desktop runtime allowlist is closed over local module imports", async () => {
  const runtimeFiles = new Set(DESKTOP_RUNTIME_FILES);
  const testOnlyImport = "desktop/runtime/main.mjs=>desktop/runtime/smoke-main.mjs";
  for (const filename of runtimeFiles) {
    if (!/\.(?:cjs|mjs)$/.test(filename) || WORKER_BUNDLE_FILES.includes(filename)) continue;
    const source = await readFile(new URL(`../${filename}`, import.meta.url), "utf8");
    const imports = source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.\.?\/[^"']+)["']/g);
    for (const [, specifier] of imports) {
      const imported = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
      if (`${filename}=>${imported}` === testOnlyImport) continue;
      assert.ok(runtimeFiles.has(imported), `${filename} imports missing packaged runtime file ${imported}`);
    }
  }
});

test("artifact policy accepts only required runtime roots and rejects private or development paths", () => {
  assert.deepEqual(assertPackagedApplicationFiles([
    ...REQUIRED_FILES,
    "assets/brand/extra-brand-asset.png",
    "dist/client/assets/index.js",
    "node_modules/vinext/dist/server/prod-server.js",
  ]), { fileCount: REQUIRED_FILES.length + 3 });
  for (const filename of [
    ".env.production",
    ".wrangler/state.json",
    "desktop/runtime/smoke-main.mjs",
    "tests/fixtures/providers/private.jsonl",
    "desktop/credentials.json",
    "dist/.cache/state.bin",
    "dist/private-data/state.json",
    "dist/client/index.js.map",
    "node_modules/example/oauth/token.json",
    "node_modules/example/secrets.json",
    "node_modules/example/id_rsa",
  ]) {
    assert.equal(forbiddenArtifactPath(filename) || !isAllowedApplicationPath(filename), true, filename);
    assert.throws(() => assertPackagedApplicationFiles([...REQUIRED_FILES, filename]), /DESKTOP_ARTIFACT_/);
  }
  assert.equal(forbiddenArtifactPath("node_modules/oauth4webapi/build/index.js"), false);
  assert.equal(forbiddenArtifactPath("node_modules/parser/dist/token.js"), false);
  assert.equal(isAllowedApplicationPath("node_modules/parser/dist/token.js"), true);
});

test("expected release and update artifact names derive from the version", () => {
  assert.deepEqual(expectedArtifactNames("1.2.3"), ["Pomegr-Setup-1.2.3-x64.exe", "Pomegr-Portable-1.2.3-x64.exe"]);
  assert.deepEqual(expectedUpdateArtifactNames("1.2.3"), ["latest.yml", "Pomegr-Setup-1.2.3-x64.exe.blockmap"]);
});

test("dependency notice generation excludes development tools and requires declared licenses", () => {
  const lock = {
    packages: {
      "": {
        version: "0.1.0",
        license: "AGPL-3.0-only",
        dependencies: { runtime: "1.2.3", "linux-only": "7.0.0", "win-arm": "8.0.0" },
      },
      "node_modules/runtime": { version: "1.2.3", license: "MIT" },
      "node_modules/dev-only": { version: "4.5.6", license: "ISC", dev: true },
      "node_modules/electron": { version: "43.3.0", license: "MIT", dev: true },
      "node_modules/linux-only": { version: "7.0.0", license: "MIT", os: ["linux"] },
      "node_modules/win-arm": { version: "8.0.0", license: "MIT", os: ["win32"], cpu: ["arm64"] },
    },
  };
  const installedLocations = new Set([
    "node_modules/runtime",
    "node_modules/dev-only",
    "node_modules/electron",
    "node_modules/linux-only",
    "node_modules/win-arm",
  ]);
  assert.deepEqual(productionDependencyNotices(lock, { arch: "x64", installedLocations, platform: "win32" }), [
    { name: "electron", version: "43.3.0", license: "MIT" },
    { name: "runtime", version: "1.2.3", license: "MIT" },
  ]);
  const notices = renderThirdPartyNotices(lock, { arch: "x64", installedLocations, platform: "win32" });
  assert.match(notices, /installed Windows x64 runtime dependencies/);
  assert.match(notices, /electron \| 43\.3\.0 \| MIT/);
  assert.match(notices, /runtime \| 1\.2\.3 \| MIT/);
  assert.doesNotMatch(notices, /dev-only/);
  assert.doesNotMatch(notices, /linux-only|win-arm/);
  assert.deepEqual(dependencyNoticeKeys(notices), ["Node.js@24.14.0", "electron@43.3.0", "runtime@1.2.3"]);
  assert.equal(isDependencyPackageManifest("node_modules/@scope/pkg/package.json"), true);
  assert.equal(isDependencyPackageManifest("node_modules/pkg/node_modules/child/package.json"), true);
  assert.equal(isDependencyPackageManifest("node_modules/pkg/dist/compiled/child/package.json"), false);
  assert.throws(() => productionDependencyNotices({ packages: {
    "": { dependencies: { missing: "1.0.0" } },
    "node_modules/missing": { version: "1.0.0" },
  } }), /DESKTOP_DEPENDENCY_LICENSE_MISSING/);
});

test("desktop update packaging fails closed when publishing, dependency, or signature verification drifts", () => {
  const base = {
    build: {
      extraMetadata: { pomegrPackagingScope: POMEGR_DT_08_PACKAGING_SCOPE },
      electronUpdaterCompatibility: ">=2.16",
      publish: [{ provider: "github", owner: "Lecarvalho", repo: "pomegr" }],
      win: { verifyUpdateCodeSignature: true, signtoolOptions: { publisherName: "DSNK Technologie Inc" } },
      nsis: { differentialPackage: true },
    },
    dependencies: { "electron-updater": "6.8.9" },
    devDependencies: {},
  };
  assert.equal(assertPomegrDt08PackagingScope(base), true);
  assert.throws(() => assertPomegrDt08PackagingScope({ ...base, build: {
    ...base.build,
    extraMetadata: { pomegrPackagingScope: "POMEGR-DT-08-no-updater" },
  } }), /DESKTOP_POMEGR_DT_08_SCOPE_REQUIRED/);
  assert.throws(() => assertPomegrDt08PackagingScope({ ...base, build: {
    ...base.build,
    publish: [{ provider: "github" }],
  } }), /DESKTOP_UPDATE_PUBLISH_INVALID/);
  assert.throws(() => assertPomegrDt08PackagingScope({ ...base, dependencies: {} }), /DESKTOP_UPDATER_DEPENDENCY_REQUIRED/);
  assert.throws(() => assertPomegrDt08PackagingScope({ ...base, build: {
    ...base.build,
    win: { verifyUpdateCodeSignature: false },
  } }), /DESKTOP_UPDATE_SIGNATURE_VERIFICATION_REQUIRED/);
});

