import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createProductionBuildFixture } from "./helpers/production-build.mjs";
import { DESKTOP_CSP } from "../desktop/runtime/security-policy.mjs";

async function artifactText(root) {
  const files = await readdir(root, { withFileTypes: true });
  const pieces = await Promise.all(files.map(async (entry) => {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) return artifactText(filename);
    if (!entry.isFile() || (await stat(filename)).size > 4 * 1024 * 1024) return "";
    return readFile(filename, "utf8").catch(() => "");
  }));
  return pieces.join("\n");
}

test("production web artifacts exclude the recorder, capture protocol, and browser trace instrumentation", async (context) => {
  const fixture = await createProductionBuildFixture();
  context.after(fixture.close);
  const artifact = await artifactText(fixture.outDir);
  const builtFiles = await readdir(fixture.outDir, { recursive: true });
  for (const file of builtFiles.filter((file) => /\.(?:css|js)$/.test(file))) {
    const source = await readFile(path.join(fixture.outDir, file), "utf8");
    assert.doesNotMatch(source, /url\([A-Za-z]:[\\/]/, file);
    if (file.endsWith(".css")) {
      for (const face of source.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
        assert.doesNotMatch(face[1], /url\(["']?(?:data:|https?:|\/\/)/, file);
      }
    }
  }
  const assets = await readdir(path.join(fixture.outDir, "client", "assets"));
  for (const family of ["inter", "cascadia-mono"]) {
    assert.ok(assets.some((file) => file.startsWith(`${family}-latin-wght-normal-`) && file.endsWith(".woff2")), family);
  }
  assert.ok(DESKTOP_CSP.split("; ").includes("font-src 'self'"));
  for (const forbidden of [
    "startPipelineTraceCaptureTransport", "pipeline-trace-transport",
    // The package manifest is bundled for its displayed version and therefore contains
    // diagnostics script/file names. Check executable composition identifiers here.
    "createDevelopmentDiagnostics", "createPipelineLogWriter",
    "/api/renderer-trace", "x-pomegr-trace-revision", "renderer_event", "renderer_react_commit", "performance.mark",
  ]) assert.equal(new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u").test(artifact), false, forbidden);
});
