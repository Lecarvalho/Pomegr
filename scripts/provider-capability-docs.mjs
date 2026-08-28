import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { providerRegistry } from "../monitor/providers/index.mjs";
import { PROVIDER_CAPABILITY_CATALOG } from "../monitor/providers/provider-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const documentationFile = path.join(repositoryRoot, "docs", "CONFIGURATION.md");
const START = "<!-- provider-capabilities:start -->";
const END = "<!-- provider-capabilities:end -->";

function cell(provider, capability) {
  const declaration = provider.capabilityManifest[capability];
  return declaration.status === "supported"
    ? "Supported"
    : `Unsupported — ${declaration.limitation.documentation}`;
}

export function renderProviderCapabilityMatrix(providers = providerRegistry.providers) {
  const header = `| Capability | Normalized evidence | ${providers.map((provider) => provider.source).join(" | ")} |`;
  const separator = `| --- | --- | ${providers.map(() => "---").join(" | ")} |`;
  const rows = PROVIDER_CAPABILITY_CATALOG.map((capability) => (
    `| ${capability.label} | \`${capability.evidencePath}\` | ${providers.map((provider) => cell(provider, capability.key)).join(" | ")} |`
  ));
  return [START, header, separator, ...rows, END].join("\n");
}

function replaceGeneratedSection(documentation, generated) {
  const start = documentation.indexOf(START);
  const end = documentation.indexOf(END);
  if (start < 0 || end < start) throw new Error("Provider capability documentation markers are missing");
  return `${documentation.slice(0, start)}${generated}${documentation.slice(end + END.length)}`;
}

const current = await readFile(documentationFile, "utf8");
const expected = replaceGeneratedSection(current, renderProviderCapabilityMatrix());
if (process.argv.includes("--write")) {
  await writeFile(documentationFile, expected, "utf8");
  console.log("Updated docs/CONFIGURATION.md provider capability matrix.");
} else if (current !== expected) {
  console.error("Provider capability documentation is out of sync. Run: npm run docs:providers");
  process.exitCode = 1;
} else {
  console.log("Provider capability documentation is in sync.");
}
