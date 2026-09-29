import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createProductionBuildFixture } from "./helpers/production-build.mjs";

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
  for (const forbidden of [
    "startPipelineTraceCaptureTransport", "pipeline-trace-transport",
    // The package manifest is bundled for its displayed version and therefore contains
    // diagnostics script/file names. Check executable composition identifiers here.
    "createDevelopmentDiagnostics", "createPipelineLogWriter",
    "/api/renderer-trace", "x-pomegr-trace-revision", "renderer_event", "renderer_react_commit", "performance.mark",
  ]) assert.equal(new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u").test(artifact), false, forbidden);
});
