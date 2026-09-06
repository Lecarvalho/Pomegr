import path from "node:path";
import {
  boundedVersion,
  canonicalDirectory,
  pluginSetupHome,
  readBounded,
  parseJsonText,
  samePath,
} from "./plugin-setup-files.mjs";

const PLUGIN_ID = "pomegr@pomegr";
const PLUGIN_NAME = "pomegr";
const OFFICIAL_REPO = "Lecarvalho/pomegr";
const SCOPES = new Set(["user", "project", "local"]);
const SCOPE_PRIORITY = { user: 1, project: 2, local: 3 };

function settingValue(settings, key) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { present: false, valid: true, value: null };
  if (!Object.hasOwn(settings, key)) return { present: false, valid: true, value: null };
  return typeof settings[key] === "boolean"
    ? { present: true, valid: true, value: settings[key] }
    : { present: true, valid: false, value: null };
}

function normalizedRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = SCOPES.has(value.scope) ? value.scope : null;
  const version = boundedVersion(value.version);
  const installPath = canonicalDirectory(value.installPath);
  const projectPath = value.projectPath === undefined ? null : canonicalDirectory(value.projectPath);
  if (!scope || !version || !installPath || (scope !== "user" && !projectPath)
    || (value.projectPath !== undefined && !projectPath)) return null;
  return { scope, version, installPath, projectPath };
}

async function readJson(file, options) {
  const result = await readBounded(file, options);
  return { ...result, value: result.status === "ready" ? parseJsonText(result.text) : null };
}

async function readSettings(file, options) {
  const result = await readJson(file, options);
  if (result.status === "missing") return { status: "missing", value: null };
  if (result.status !== "ready" || !result.value) return { status: "invalid", value: null };
  const enabled = result.value.enabledPlugins;
  const marketplaces = result.value.extraKnownMarketplaces;
  if ((enabled !== undefined && (typeof enabled !== "object" || Array.isArray(enabled)))
    || (marketplaces !== undefined && (typeof marketplaces !== "object" || Array.isArray(marketplaces)))) {
    return { status: "invalid", value: null };
  }
  return {
    status: "ready",
    value: enabled && typeof enabled === "object" && !Array.isArray(enabled) ? enabled : Object.create(null),
    marketplaces: marketplaces && typeof marketplaces === "object" && !Array.isArray(marketplaces) ? marketplaces : Object.create(null),
  };
}

async function readInstalled(home, options) {
  const result = await readJson(path.join(home, "plugins", "installed_plugins.json"), options);
  if (result.status !== "ready") return result;
  if (!result.value || result.value.version !== 2 || !result.value.plugins || typeof result.value.plugins !== "object" || Array.isArray(result.value.plugins)) {
    return { status: "invalid", value: null };
  }
  return result;
}

async function verifyManifest(record, options) {
  const result = await readJson(path.join(record.installPath, ".claude-plugin", "plugin.json"), options);
  if (result.status !== "ready" || !result.value) return false;
  return result.value.name === PLUGIN_NAME && result.value.version === record.version;
}

function marketplaceInfo(result, settings = []) {
  if (settings.some((entry) => ["invalid", "unavailable"].includes(entry?.status))) {
    return { marketplaceRegistered: false, ref: null, sourceTrusted: false };
  }
  const known = result?.status === "ready" && result.value && typeof result.value === "object" && !Array.isArray(result.value)
    ? result.value
    : null;
  const configured = [
    known && Object.hasOwn(known, "pomegr") ? known.pomegr : undefined,
    ...settings.map((entry) => entry?.status === "ready" && Object.hasOwn(entry.marketplaces || {}, "pomegr")
      ? entry.marketplaces.pomegr
      : undefined),
  ].filter((value) => value !== undefined);
  if (!known && configured.length === 0) return { marketplaceRegistered: false, ref: null, sourceTrusted: result?.status === "missing" };
  if (configured.length === 0) return { marketplaceRegistered: false, ref: null, sourceTrusted: true };
  const provenance = configured.map((value) => JSON.stringify({ source: value?.source ?? null, ref: value?.ref ?? null }));
  if (new Set(provenance).size !== 1) return { marketplaceRegistered: true, ref: null, sourceTrusted: false };
  const value = configured[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { marketplaceRegistered: true, ref: null, sourceTrusted: false };
  }
  const source = value.source;
  const trusted = source && typeof source === "object" && !Array.isArray(source)
    && source.source === "github" && source.repo === OFFICIAL_REPO;
  const sourceRef = source && typeof source.ref === "string" && /^[0-9A-Za-z][0-9A-Za-z./_-]{0,127}$/.test(source.ref)
    ? source.ref
    : typeof value.ref === "string" && /^[0-9A-Za-z][0-9A-Za-z./_-]{0,127}$/.test(value.ref)
      ? value.ref
      : null;
  return { marketplaceRegistered: true, ref: sourceRef, sourceTrusted: Boolean(trusted) };
}

function emptyPrivateAction() {
  return { marketplaceRegistered: false, ref: null, sourceTrusted: false };
}

export function createClaudePluginSetupReader(options = {}) {
  const environment = options.env || options.environment || process.env;
  const home = canonicalDirectory(options.configRoot || environment.CLAUDE_CONFIG_DIR || path.join(pluginSetupHome({ ...options, env: environment }), ".claude"));
  const readOptions = { readFile: options.readFile };
  return async function readRepositoryPluginSetup(input = {}) {
    const cwd = typeof input === "string" ? input : input?.cwd || process.cwd();
    const project = canonicalDirectory(cwd);
    if (!home || !project) return { installation: "unknown", version: null, enabled: null, scope: null, privateAction: emptyPrivateAction() };

    const [installed, marketplaces, userSettings, projectSettings, localSettings] = await Promise.all([
      readInstalled(home, readOptions),
      readJson(path.join(home, "plugins", "known_marketplaces.json"), readOptions),
      readSettings(path.join(home, "settings.json"), readOptions),
      readSettings(path.join(project, ".claude", "settings.json"), readOptions),
      readSettings(path.join(project, ".claude", "settings.local.json"), readOptions),
    ]);
    const settings = [userSettings, projectSettings, localSettings];
    const privateAction = marketplaceInfo(marketplaces, settings);
    if (installed.status === "missing") return { installation: "not_installed", version: null, enabled: null, scope: null, privateAction };
    if (installed.status !== "ready") return { installation: "unknown", version: null, enabled: null, scope: null, privateAction };

    const raw = installed.value.plugins[PLUGIN_ID];
    const candidates = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    if (candidates.length > 64 || (raw !== undefined && candidates.length === 0)) return { installation: "unknown", version: null, enabled: null, scope: null, privateAction };
    const normalized = candidates.map(normalizedRecord);
    if (normalized.some((entry) => !entry)) return { installation: "unknown", version: null, enabled: null, scope: null, privateAction };
    const matching = normalized.filter((entry) => entry.scope === "user" || samePath(entry.projectPath, project));
    const bestScope = matching.reduce((best, entry) => Math.max(best, SCOPE_PRIORITY[entry.scope] || 0), 0);
    const selected = matching.filter((entry) => SCOPE_PRIORITY[entry.scope] === bestScope);
    if (selected.length === 0) return { installation: "not_installed", version: null, enabled: null, scope: null, privateAction };
    if (selected.length !== 1 || !(await verifyManifest(selected[0], readOptions))) {
      return { installation: "unknown", version: null, enabled: null, scope: null, privateAction };
    }

    let enabled = null;
    let enablementInvalid = false;
    for (const entry of settings) {
      if (entry.status === "invalid") { enabled = null; enablementInvalid = true; continue; }
      if (enablementInvalid) continue;
      const setting = settingValue(entry.value, PLUGIN_ID);
      if (!setting.valid) enabled = null;
      else if (setting.present) enabled = setting.value;
    }
    const record = selected[0];
    return {
      installation: "installed",
      version: record.version,
      enabled,
      scope: record.scope,
      privateAction,
    };
  };
}
