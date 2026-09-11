module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment: "Unreferenced production modules are rejected unless they match a documented configuration or entrypoint exception.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "(^|[/\\\\])[.][^/\\\\]+[.](?:js|cjs|mjs|ts|cts|mts|json)$",
          "[.]d[.]ts$",
          // Vinext discovers this fixed capability endpoint without a source import.
          "^app[/\\\\]api[/\\\\]client-access[/\\\\]route[.]ts$",
          "(^|[/\\\\])tsconfig[.]json$",
          "(^|[/\\\\])(?:babel|webpack|vite|vitest|postcss|eslint)[.]config[.](?:js|cjs|mjs|ts|cts|mts|json)$",
        ],
      },
      to: {},
    },
    {
      name: "shared-cannot-import-runtime",
      comment: "Shared normalized contracts must remain usable by every runtime.",
      severity: "error",
      from: { path: "^shared[/\\\\]" },
      to: { path: "^(?:app|desktop|landing|mcp|monitor|web|worker)[/\\\\]" },
    },
    {
      name: "app-cannot-import-server",
      comment: "The browser must consume same-origin normalized API routes only.",
      severity: "error",
      from: { path: "^app[/\\\\]" },
      to: { path: "^(?:desktop|mcp|monitor|worker)[/\\\\]" },
    },
    {
      name: "providers-cannot-import-ui-or-desktop",
      severity: "error",
      from: { path: "^monitor[/\\\\]providers[/\\\\]" },
      to: { path: "^(?:app|desktop|landing)[/\\\\]" },
    },
    {
      name: "generic-monitor-cannot-import-provider-implementation",
      comment: "Generic monitor code reaches providers through the registry/contract seam.",
      severity: "error",
      from: { path: "^monitor[/\\\\](?!providers[/\\\\])" },
      to: { path: "^monitor[/\\\\]providers[/\\\\](?!(?:index|registry|provider-contract)[.]mjs$).+" },
    },
  ],
  options: {
    doNotFollow: {
      path: ["(^|[/\\\\])node_modules([/\\\\]|$)", "(^|[/\\\\])dist([/\\\\]|$)", "(^|[/\\\\])plugins([/\\\\]|$)"],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    preserveSymlinks: false,
    moduleSystems: ["es6", "cjs"],
  },
};
