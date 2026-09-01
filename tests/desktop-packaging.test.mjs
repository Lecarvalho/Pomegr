import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXTERNAL_LEGAL_FILES,
  EXTERNAL_RUNTIME_FILES,
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
} from "../desktop/artifact-policy.mjs";
import { productionDependencyNotices, renderThirdPartyNotices } from "../desktop/legal-notices.mjs";
import { SHARP_UNPACKED_FILES, WORKER_BUNDLE_FILES } from "../desktop/asar-policy.mjs";
import {
  ACCEPTANCE_PRIOR_ARTIFACT,
  ACCEPTANCE_PRIOR_OUTPUT,
  ACCEPTANCE_PRIOR_VERSION,
} from "../desktop/acceptance-prior.mjs";
import { POMEGR_DT_08_PACKAGING_SCOPE, assertPomegrDt08PackagingScope } from "../desktop/pomegr-dt-08-scope.mjs";

const REQUIRED_FILES = [
  ...PUBLIC_LEGAL_FILES,
  ...DESKTOP_RUNTIME_FILES,
  ...BRAND_ASSET_FILES,
  "dist/server/index.js",
  "package.json",
];

test("desktop builder produces per-user NSIS and portable artifacts from an explicit allowlist", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const build = packageJson.build;
  assert.equal(build.appId, "com.pomegr.desktop");
  assert.equal(build.productName, "Pomegr");
  assert.equal(build.electronDist, "node_modules/electron/dist");
  assert.equal(build.win.executableName, "Pomegr");
  assert.equal(build.win.requestedExecutionLevel, "asInvoker");
  assert.deepEqual(build.win.target, [
    { target: "nsis", arch: ["x64"] },
    { target: "portable", arch: ["x64"] },
  ]);
  assert.equal(build.nsis.oneClick, true);
  assert.equal(build.nsis.perMachine, false);
  assert.equal(build.nsis.allowElevation, false);
  assert.equal(build.nsis.packElevateHelper, false);
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(build.nsis.differentialPackage, true);
  assert.equal(build.nsis.createDesktopShortcut, "always");
  assert.equal(build.nsis.createStartMenuShortcut, true);
  assert.equal(build.portable.requestExecutionLevel, "user");
  assert.deepEqual(expectedArtifactNames(packageJson.version), [
    `Pomegr-Setup-${packageJson.version}-x64.exe`,
    `Pomegr-Portable-${packageJson.version}-x64.exe`,
  ]);
  assert.deepEqual(expectedUpdateArtifactNames(packageJson.version), [
    "latest.yml",
    `Pomegr-Setup-${packageJson.version}-x64.exe.blockmap`,
  ]);
  assert.ok(build.files.length > 20);
  assert.equal(build.files.includes("**/*"), false);
  assert.equal(build.files.includes("desktop/**/*"), false);
  assert.equal(build.files.includes("tests/**/*"), false);
  assert.equal(build.files.includes("assets/brand/**/*"), true);
  assert.equal(build.files.includes("build/icon.png"), true);
  assert.deepEqual(build.extraResources.map(({ to }) => to).sort(), [...EXTERNAL_LEGAL_FILES, ...EXTERNAL_RUNTIME_FILES].sort());
  assert.match(packageJson.scripts["desktop:package"], /electron-builder --win nsis portable --x64/);
  assert.match(packageJson.scripts["desktop:package"], /prepare-builder-cache\.mjs/);
  assert.match(packageJson.scripts["desktop:package"], /finalize-package\.mjs/);
  assert.match(packageJson.scripts.lint, /ignore-pattern release/);
  assert.match(packageJson.scripts.lint, /ignore-pattern release-acceptance/);
  assert.equal(build.afterPack, "desktop/after-pack.mjs");
  assert.equal(build.extraMetadata.pomegrPackagingScope, POMEGR_DT_08_PACKAGING_SCOPE);
  assert.deepEqual(build.publish, [{ provider: "github", owner: "Lecarvalho", repo: "pomegr" }]);
  assert.equal(build.electronUpdaterCompatibility, ">=2.16");
  assert.equal(build.win.verifyUpdateCodeSignature, true);
  assert.equal(build.win.signtoolOptions.publisherName, "Leandro Carvalho");
  assert.equal(packageJson.dependencies["electron-updater"], "6.8.9");
  assert.deepEqual(build.asarUnpack, [
    "desktop/workers/**/*",
    "dist/**/*",
    "node_modules/@img/sharp-win32-x64/lib/**/*",
  ]);
  assert.deepEqual(build.files.filter((filename) => /^(?:desktop|shared|web)\//.test(filename)), DESKTOP_RUNTIME_FILES);
  assert.doesNotThrow(() => assertPomegrDt08PackagingScope(packageJson));
  assert.equal(packageJson.dependencies.vinext, "0.0.50");
});

test("packaged desktop runtime allowlist is closed over local module imports", async () => {
  const runtimeFiles = new Set(DESKTOP_RUNTIME_FILES);
  const testOnlyImport = "desktop/main.mjs=>desktop/smoke-main.mjs";
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

test("desktop builder cache gives downloaded CommonJS tools an explicit package scope", async () => {
  const source = await readFile(new URL("../desktop/prepare-builder-cache.mjs", import.meta.url), "utf8");
  assert.match(source, /Object\.freeze\(\{ private: true, type: "commonjs" \}\)/);
  assert.match(source, /details\.isSymbolicLink\(\)/);
  assert.match(source, /writeFile\(cachePackagePath, cachePackageText, \{ flag: "wx" \}\)/);
  assert.doesNotMatch(source, /rm\(|unlink\(|Remove-Item/);
});

test("artifact policy accepts only required runtime roots and rejects private or development paths", () => {
  assert.deepEqual(assertPackagedApplicationFiles([
    ...REQUIRED_FILES,
    "assets/brand/pomegr-lockup-color.svg",
    "dist/client/assets/index.js",
    "node_modules/vinext/dist/server/prod-server.js",
  ]), { fileCount: REQUIRED_FILES.length + 3 });
  for (const filename of [
    ".env.production",
    ".wrangler/state.json",
    "desktop/smoke-main.mjs",
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
  assert.deepEqual(dependencyNoticeKeys(notices), ["electron@43.3.0", "runtime@1.2.3"]);
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
      win: { verifyUpdateCodeSignature: true, signtoolOptions: { publisherName: "Leandro Carvalho" } },
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

test("packaged legal copies match canonical project documents and About links every copy", async () => {
  const mappings = [
    ["LICENSE", "LICENSE.txt"],
    ["NOTICE", "NOTICE.txt"],
    ["SOURCE.md", "SOURCE.txt"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.txt"],
    ["TRADEMARKS.md", "TRADEMARKS.txt"],
  ];
  for (const [canonical, packaged] of mappings) {
    const [source, publicCopy] = await Promise.all([
      readFile(new URL(`../${canonical}`, import.meta.url), "utf8"),
      readFile(new URL(`../public/legal/${packaged}`, import.meta.url), "utf8"),
    ]);
    assert.equal(publicCopy.replaceAll("\r\n", "\n"), source.replaceAll("\r\n", "\n"));
  }
  const [about, notices] = await Promise.all([
    readFile(new URL("../app/about/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"),
  ]);
  for (const [, packaged] of mappings) assert.match(about, new RegExp(`/legal/${packaged.replaceAll(".", "\\.")}`));
  assert.match(notices, /electron \| 43\.3\.0 \| MIT/);
  assert.match(notices, /vinext \| 0\.0\.50 \| MIT/);
  assert.doesNotMatch(notices, /electron-builder/);
  assert.equal(SHARP_UNPACKED_FILES.length, 3);
  assert.deepEqual(WORKER_BUNDLE_FILES, ["desktop/workers/monitor-host.cjs", "desktop/workers/claude-statusline-bridge.cjs"]);
});

test("clean-VM upgrade fixture is isolated, test-only, and preserves candidate metadata", async () => {
  const [packageText, builder, inspector, checklist, gitignore] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../desktop/build-acceptance-prior.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/inspect-acceptance-prior.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/DESKTOP_CLEAN_VM_CHECKLIST.md", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  assert.equal(packageJson.version, "0.2.0");
  assert.equal(ACCEPTANCE_PRIOR_VERSION, "0.0.9");
  assert.equal(ACCEPTANCE_PRIOR_OUTPUT, "release-acceptance");
  assert.equal(ACCEPTANCE_PRIOR_ARTIFACT, "Pomegr-TestOnly-Prior-0.0.9-x64.exe");
  assert.match(packageJson.scripts["desktop:package:acceptance-prior"], /build-acceptance-prior\.mjs/);
  assert.match(packageJson.scripts["desktop:inspect:acceptance-prior"], /inspect-acceptance-prior\.mjs/);
  assert.match(builder, /Platform\.WINDOWS\.createTarget\(\["nsis"\], Arch\.x64\)/);
  assert.match(builder, /pomegrPackagingScope/);
  assert.doesNotMatch(builder, /appId\s*:/);
  assert.match(inspector, /assertPackagedApplicationFiles/);
  assert.match(gitignore, /^\/release-acceptance\/$/m);
  assert.match(checklist, /Pomegr-TestOnly-Prior-0\.0\.9-x64\.exe/);
  assert.match(checklist, /Pomegr-Setup-0\.2\.0-x64\.exe/);
  assert.match(checklist, /Pomegr-Portable-0\.2\.0-x64\.exe/);
  assert.match(checklist, /SmartScreen/);
  assert.match(checklist, /POMEGR-DT-08/);
  assert.match(checklist, /Acceptance status\s+\*\*PENDING:/);
  assert.match(checklist, /contains no Pomegr 0\.2\.0 PASS claim/);
  assert.match(checklist, /prior-only input, not Pomegr 0\.2\.0 proof/);
  assert.doesNotMatch(checklist, /- \[x\]/i);
  assert.doesNotMatch(checklist, /\|\s*Result\s*\|\s*PASS\s*\|/i);
  assert.doesNotMatch(checklist, /\b[A-F0-9]{64}\b/);
  assert.doesNotMatch(checklist, /\|\s*[\d,]{6,}\s*\|/);
});
