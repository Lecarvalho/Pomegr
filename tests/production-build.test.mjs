import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import lockfile from "proper-lockfile";
import { tryServeStatic } from "vinext/server/prod-server";
import { withProductionBuildLock } from "../scripts/production-build-lock.mjs";
import { createProductionBuildFixture } from "./helpers/production-build.mjs";

async function sourceBuild(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-build-source-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const assets = path.join(root, "dist", "client", "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, "page-original.css"), "body { color: red; }");
  return { root, assets };
}

test("production-test assets survive replacement of the checkout build", async (context) => {
  const { root, assets } = await sourceBuild(context);
  const fixture = await createProductionBuildFixture(root);
  context.after(fixture.close);
  const server = http.createServer((request, response) => {
    void tryServeStatic(request, response, path.join(fixture.outDir, "client"), request.url, false)
      .then((served) => { if (!served) { response.writeHead(404); response.end(); } })
      .catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  // A rebuild removes the filename already referenced by a rendered page.
  await withProductionBuildLock(root, async () => {
    await rm(path.join(assets, "page-original.css"));
    await writeFile(path.join(assets, "page-rebuilt.css"), "body { color: blue; }");
  });
  await assert.rejects(readFile(path.join(assets, "page-original.css")), { code: "ENOENT" });
  const asset = await fetch("http://127.0.0.1:" + server.address().port + "/assets/page-original.css");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "body { color: red; }");
});

test("production build lock excludes another writer and releases after failure", async (context) => {
  const { root } = await sourceBuild(context);
  await assert.rejects(withProductionBuildLock(root, async () => {
    await assert.rejects(lockfile.lock(root, {
      lockfilePath: path.join(root, ".wrangler", "production-build.lock"), retries: 0,
    }), { code: "ELOCKED" });
    throw new Error("Build failed");
  }), /Build failed/);
  const fixture = await createProductionBuildFixture(root);
  context.after(fixture.close);
  assert.equal(await readFile(path.join(fixture.outDir, "client", "assets", "page-original.css"), "utf8"), "body { color: red; }");
});
