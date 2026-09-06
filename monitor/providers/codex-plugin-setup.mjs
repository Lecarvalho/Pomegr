import path from "node:path";
import {
  boundedVersion,
  canonicalDirectory,
  listBoundedDirectories,
  parseJsonText,
  pluginSetupHome,
  readBounded,
  readTomlSection,
} from "./plugin-setup-files.mjs";

const PLUGIN_ID = "pomegr@pomegr";
const OFFICIAL_SOURCE = "https://github.com/Lecarvalho/pomegr.git";

function comparableVersion(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || ""];
}

function compareVersions(left, right) {
  const a = comparableVersion(left);
  const b = comparableVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  if (a[3] || b[3]) return a[3] === b[3] ? 0 : null;
  return 0;
}

function emptyPrivateAction() {
  return { marketplaceRegistered: false, ref: null, sourceTrusted: false };
}

async function readJson(file, options) {
  const result = await readBounded(file, options);
  return { ...result, value: result.status === "ready" ? parseJsonText(result.text) : null };
}

async function readManifest(directory, options) {
  const result = await readJson(path.join(directory, ".codex-plugin", "plugin.json"), options);
  if (result.status === "missing") return { status: "missing", version: null };
  if (result.status !== "ready" || !result.value) return { status: "malformed", version: null };
  const version = boundedVersion(result.value.version);
  return result.value.name === "pomegr" && version === path.basename(directory)
    ? { status: "valid", version }
    : { status: "malformed", version: null };
}

async function findInstalled(codexHome, options) {
  const root = path.join(codexHome, "plugins", "cache", "pomegr", "pomegr");
  const listing = await listBoundedDirectories(root, options);
  if (listing.status !== "ready") return { ...listing, versions: [], malformed: false };
  const versions = [];
  let malformed = false;
  for (const entry of listing.entries) {
    if (!boundedVersion(entry.name)) continue;
    const manifest = await readManifest(path.join(root, entry.name), options);
    if (manifest.status === "valid") versions.push(manifest.version);
    else if (manifest.status === "malformed") malformed = true;
  }
  return { status: "ready", versions, malformed };
}

export function createCodexPluginSetupReader(options = {}) {
  const environment = options.env || options.environment || process.env;
  const home = canonicalDirectory(options.codexHome || environment.CODEX_HOME || path.join(pluginSetupHome({ ...options, env: environment }), ".codex"));
  const readOptions = { readFile: options.readFile, readDir: options.readDir };
  return async function readRepositoryPluginSetup(input = {}) {
    if (!home) return { installation: "unknown", version: null, enabled: null, scope: null, privateAction: emptyPrivateAction() };
    const cwd = canonicalDirectory(typeof input === "string" ? input : input?.cwd || process.cwd());
    const requirementsPath = options.requirementsFile || (environment.ProgramData
      ? path.join(environment.ProgramData, "OpenAI", "Codex", "requirements.toml")
      : null);
    const [configResult, projectConfigResult, requirementsResult, legacyManagedResult] = await Promise.all([
      readBounded(path.join(home, "config.toml"), readOptions),
      cwd ? readBounded(path.join(cwd, ".codex", "config.toml"), readOptions) : Promise.resolve({ status: "missing", text: null }),
      requirementsPath ? readBounded(requirementsPath, readOptions) : Promise.resolve({ status: "missing", text: null }),
      readBounded(path.join(home, "managed_config.toml"), readOptions),
    ]);
    if (configResult.status !== "ready"
      || [projectConfigResult, requirementsResult, legacyManagedResult].some((result) => ["invalid", "unavailable"].includes(result.status))) {
      return { installation: "unknown", version: null, enabled: null, scope: null, privateAction: emptyPrivateAction() };
    }
    const pluginSection = (text) => readTomlSection(text, `plugins."${PLUGIN_ID}"`)
      || readTomlSection(text, `plugins.'${PLUGIN_ID}'`);
    const marketplaceSection = (text) => readTomlSection(text, "marketplaces.pomegr");
    const projectPlugin = projectConfigResult.status === "ready" ? pluginSection(projectConfigResult.text) : null;
    const projectMarketplace = projectConfigResult.status === "ready" ? marketplaceSection(projectConfigResult.text) : null;
    const requirementsPlugin = requirementsResult.status === "ready" ? pluginSection(requirementsResult.text) : null;
    const requirementsMarketplace = requirementsResult.status === "ready" ? marketplaceSection(requirementsResult.text) : null;
    const legacyManagedPlugin = legacyManagedResult.status === "ready" ? pluginSection(legacyManagedResult.text) : null;
    const legacyManagedMarketplace = legacyManagedResult.status === "ready" ? marketplaceSection(legacyManagedResult.text) : null;
    const globalPlugin = pluginSection(configResult.text);
    const globalMarketplace = marketplaceSection(configResult.text);
    if ([projectPlugin, projectMarketplace, requirementsPlugin, requirementsMarketplace, legacyManagedPlugin, legacyManagedMarketplace, globalPlugin, globalMarketplace]
      .some((section) => section?.__invalid)) {
      return { installation: "unknown", version: null, enabled: null, scope: null, privateAction: emptyPrivateAction() };
    }
    const plugin = requirementsPlugin || legacyManagedPlugin || projectPlugin || globalPlugin;
    const marketplace = requirementsMarketplace || legacyManagedMarketplace || projectMarketplace || globalMarketplace;
    const source = marketplace?.source;
    const sourceType = marketplace?.source_type || (source && typeof source === "object" ? source.type || source.source : null);
    const sourceUrl = typeof source === "string" ? source : source && typeof source === "object" ? source.url || source.source : null;
    const refValue = marketplace?.ref || (source && typeof source === "object" ? source.ref : null);
    const ref = typeof refValue === "string" && refValue.length <= 128 ? refValue : null;
    const privateAction = {
      marketplaceRegistered: Boolean(marketplace),
      ref,
      sourceTrusted: !marketplace || (sourceType === "git" && sourceUrl === OFFICIAL_SOURCE),
    };
    const installed = await findInstalled(home, readOptions);
    if (installed.malformed) {
      return { installation: "unknown", version: null, enabled: null, scope: null, privateAction };
    }
    if (installed.status !== "ready" || installed.versions.length === 0) {
      const absent = installed.status === "missing" || (installed.status === "ready" && !installed.malformed);
      return { installation: absent ? "not_installed" : "unknown", version: null, enabled: null, scope: null, privateAction };
    }
    let version = installed.versions[0];
    for (const candidate of installed.versions.slice(1)) {
      const comparison = compareVersions(version, candidate);
      if (comparison === null) return { installation: "unknown", version: null, enabled: null, scope: null, privateAction };
      if (comparison < 0) version = candidate;
    }
    const enabled = typeof plugin?.enabled === "boolean" ? plugin.enabled : null;
    return { installation: "installed", version, enabled, scope: "user", privateAction };
  };
}
