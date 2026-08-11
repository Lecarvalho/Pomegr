import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXTERNAL_LEGAL_FILES,
  PUBLIC_LEGAL_FILES,
  DESKTOP_RUNTIME_FILES,
  assertPackagedApplicationFiles,
  dependencyNoticeKeys,
  expectedArtifactNames,
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
import { TL_DT_05_PACKAGING_SCOPE, assertTlDt05PackagingScope } from "../desktop/tl-dt-05-scope.mjs";

const REQUIRED_FILES = [
  ...PUBLIC_LEGAL_FILES,
  ...DESKTOP_RUNTIME_FILES,
  "dist/server/index.js",
  "package.json",
];

test("desktop builder produces per-user NSIS and portable artifacts from an explicit allowlist", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const build = packageJson.build;
  assert.equal(build.appId, "com.threadlight.desktop");
  assert.equal(build.productName, "Threadlight");
  assert.equal(build.electronDist, "node_modules/electron/dist");
  assert.equal(build.win.executableName, "Threadlight");
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
  assert.equal(build.nsis.differentialPackage, false);
  assert.equal(build.nsis.createDesktopShortcut, "always");
  assert.equal(build.nsis.createStartMenuShortcut, true);
  assert.equal(build.portable.requestExecutionLevel, "user");
  assert.deepEqual(expectedArtifactNames(packageJson.version), [
    `Threadlight-Setup-${packageJson.version}-x64.exe`,
    `Threadlight-Portable-${packageJson.version}-x64.exe`,
  ]);
  assert.ok(build.files.length > 20);
  assert.equal(build.files.includes("**/*"), false);
  assert.equal(build.files.includes("desktop/**/*"), false);
  assert.equal(build.files.includes("tests/**/*"), false);
  assert.deepEqual(build.extraResources.map(({ to }) => to).sort(), [...EXTERNAL_LEGAL_FILES].sort());
  assert.match(packageJson.scripts["desktop:package"], /electron-builder --win nsis portable --x64/);
  assert.match(packageJson.scripts["desktop:package"], /finalize-package\.mjs/);
  assert.match(packageJson.scripts.lint, /ignore-pattern release/);
  assert.equal(build.afterPack, "desktop/after-pack.mjs");
  assert.equal(build.extraMetadata.threadlightPackagingScope, TL_DT_05_PACKAGING_SCOPE);
  assert.equal(build.publish, undefined);
  assert.deepEqual(build.asarUnpack, [
    "desktop/workers/**/*",
    "dist/**/*",
    "node_modules/@img/sharp-win32-x64/lib/**/*",
  ]);
  assert.deepEqual(build.files.filter((filename) => /^(?:desktop|shared|web)\//.test(filename)), DESKTOP_RUNTIME_FILES);
  assert.doesNotThrow(() => assertTlDt05PackagingScope(packageJson));
  assert.equal(packageJson.dependencies.vinext, "0.0.50");
});

test("artifact policy accepts only required runtime roots and rejects private or development paths", () => {
  assert.deepEqual(assertPackagedApplicationFiles([
    ...REQUIRED_FILES,
    "dist/client/assets/index.js",
    "node_modules/vinext/dist/server/prod-server.js",
  ]), { fileCount: REQUIRED_FILES.length + 2 });
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

test("TL-DT-05 updater stripping fails closed when release-update configuration appears", () => {
  const base = {
    build: { extraMetadata: { threadlightPackagingScope: TL_DT_05_PACKAGING_SCOPE } },
    dependencies: {},
    devDependencies: {},
  };
  assert.equal(assertTlDt05PackagingScope(base), true);
  assert.throws(() => assertTlDt05PackagingScope({ ...base, build: {
    ...base.build,
    extraMetadata: { threadlightPackagingScope: "TL-DT-08-updater" },
  } }), /DESKTOP_TL_DT_05_SCOPE_REQUIRED/);
  assert.throws(() => assertTlDt05PackagingScope({ ...base, build: {
    ...base.build,
    publish: [{ provider: "github" }],
  } }), /DESKTOP_TL_DT_05_PUBLISH_FORBIDDEN/);
  assert.throws(() => assertTlDt05PackagingScope({ ...base, dependencies: {
    "electron-updater": "1.0.0",
  } }), /DESKTOP_TL_DT_05_UPDATER_FORBIDDEN/);
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
  assert.deepEqual(WORKER_BUNDLE_FILES, ["desktop/workers/monitor-host.cjs"]);
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
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(ACCEPTANCE_PRIOR_VERSION, "0.0.9");
  assert.equal(ACCEPTANCE_PRIOR_OUTPUT, "release-acceptance");
  assert.equal(ACCEPTANCE_PRIOR_ARTIFACT, "Threadlight-TestOnly-Prior-0.0.9-x64.exe");
  assert.match(packageJson.scripts["desktop:package:acceptance-prior"], /build-acceptance-prior\.mjs/);
  assert.match(packageJson.scripts["desktop:inspect:acceptance-prior"], /inspect-acceptance-prior\.mjs/);
  assert.match(builder, /Platform\.WINDOWS\.createTarget\(\["nsis"\], Arch\.x64\)/);
  assert.match(builder, /threadlightPackagingScope/);
  assert.doesNotMatch(builder, /appId\s*:/);
  assert.match(inspector, /assertPackagedApplicationFiles/);
  assert.match(gitignore, /^\/release-acceptance\/$/m);
  assert.match(checklist, /Threadlight-TestOnly-Prior-0\.0\.9-x64\.exe/);
  assert.match(checklist, /Threadlight-Setup-0\.1\.0-x64\.exe/);
  assert.match(checklist, /Threadlight-Portable-0\.1\.0-x64\.exe/);
  assert.match(checklist, /SmartScreen/);
  assert.match(checklist, /expected to be unsigned until signing is implemented in `TL-DT-08`/);
});
