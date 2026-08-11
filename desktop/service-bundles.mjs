import path from "node:path";

import { build } from "vite";

const serviceEntries = Object.freeze([
  ["monitor-host.mjs", "monitor-host.cjs"],
]);

export async function buildDesktopServiceBundles(repositoryRoot, stagingRoot) {
  const outDir = path.join(stagingRoot, "desktop", "workers");
  for (const [sourceName, outputName] of serviceEntries) {
    await build({
      root: repositoryRoot,
      configFile: false,
      envFile: false,
      publicDir: false,
      logLevel: "silent",
      ssr: { noExternal: true },
      build: {
        target: "node22",
        ssr: path.join(repositoryRoot, "desktop", sourceName),
        outDir,
        codeSplitting: false,
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
        rollupOptions: {
          output: {
            entryFileNames: outputName,
            format: "cjs",
          },
        },
      },
    });
  }
}
