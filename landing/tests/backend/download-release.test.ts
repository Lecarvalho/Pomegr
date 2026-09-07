import { afterEach, describe, expect, it, vi } from "vitest";
import { getDownloadRelease, parseDownloadRelease } from "../../server/download-release";

const release = () => ({
  tag_name: "v1.2.3", draft: false, prerelease: false,
  assets: [
    { name: "Pomegr-Setup-1.2.3-x64.exe", size: 123456789, state: "uploaded" },
    { name: "Pomegr-Portable-1.2.3-x64.exe", size: 123456780, state: "uploaded" },
  ],
});

afterEach(() => vi.unstubAllGlobals());

describe("public desktop downloads", () => {
  it("selects a complete stable release and constructs only official direct asset URLs", () => {
    const input = release();
    const result = parseDownloadRelease({ ...input, browser_download_url: "https://untrusted.example/app.exe" });
    expect(result.version).toBe("1.2.3");
    expect(result.installer.url).toBe("https://github.com/Lecarvalho/Pomegr/releases/download/v1.2.3/Pomegr-Setup-1.2.3-x64.exe");
    expect(result.portable.url).toBe("https://github.com/Lecarvalho/Pomegr/releases/download/v1.2.3/Pomegr-Portable-1.2.3-x64.exe");
  });

  it("rejects partial, duplicate, draft, prerelease, and invalid asset metadata", () => {
    const input = release();
    for (const invalid of [
      { ...input, assets: input.assets.slice(0, 1) },
      { ...input, assets: [...input.assets, input.assets[0]] },
      { ...input, draft: true },
      { ...input, prerelease: true },
      { ...input, tag_name: "../../elsewhere" },
      { ...input, assets: [{ ...input.assets[0], size: -1 }, input.assets[1]] },
    ]) expect(() => parseDownloadRelease(invalid)).toThrow();
  });

  it("uses fresh release metadata when GitHub succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(release())));
    expect((await getDownloadRelease()).version).toBe("1.2.3");
  });

  it("keeps verified download links when GitHub fails or returns an incomplete release", async () => {
    for (const response of [new Response(null, { status: 403 }), Response.json({}), new Response("invalid JSON")]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      expect((await getDownloadRelease()).installer.name).toBe("Pomegr-Setup-0.3.3-x64.exe");
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect((await getDownloadRelease()).portable.name).toBe("Pomegr-Portable-0.3.3-x64.exe");
  });
});
