import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse } from "miniflare";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("resolves current downloads in workerd and refuses upstream redirects", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { getDownloadRelease } from "./server/download-release";
        export default { async fetch() { return Response.json(await getDownloadRelease()); } };`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const requests: string[] = [];
  let redirect = false;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: "2026-05-22",
    script: bundle.outputFiles[0].text,
    outboundService(request) {
      requests.push(request.url);
      if (redirect) return new WorkerResponse(null, {
        status: 302,
        headers: { Location: "https://unexpected.example/release" },
      });
      return WorkerResponse.json({
        tag_name: "v1.2.3", draft: false, prerelease: false,
        assets: [
          { name: "Pomegr-Setup-1.2.3-x64.exe", size: 123456789, state: "uploaded" },
          { name: "Pomegr-Portable-1.2.3-x64.exe", size: 123456780, state: "uploaded" },
        ],
      });
    },
  }));
  try {
    const fresh = await (await runtime.dispatchFetch("http://localhost/")).json();
    expect(fresh).toMatchObject({ version: "1.2.3" });
    redirect = true;
    const fallback = await (await runtime.dispatchFetch("http://localhost/")).json();
    expect(fallback).toMatchObject({ version: "0.3.6" });
    expect(requests).toEqual([
      "https://api.github.com/repos/Lecarvalho/Pomegr/releases/latest",
      "https://api.github.com/repos/Lecarvalho/Pomegr/releases/latest",
    ]);
  } finally {
    await runtime.dispose();
  }
}, 15000);
