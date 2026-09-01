import path from "node:path";

import { build } from "vite";

const serviceEntries = Object.freeze([
  ["monitor-host.mjs", "monitor-host.cjs"],
  ["../scripts/claude-statusline-bridge.mjs", "claude-statusline-bridge.cjs"],
]);

export async function buildDesktopServiceBundles(repositoryRoot, stagingRoot) {
  const outDir = path.join(stagingRoot, "desktop", "workers");
  for (const [index, [sourceName, outputName]] of serviceEntries.entries()) {
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
        // Vite clears its output directory by default.  Keep the previously generated
        // worker when emitting the second standalone service bundle.
        emptyOutDir: index === 0,
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
