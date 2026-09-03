import { createHash } from "node:crypto";
import { execFile as defaultExecFile } from "node:child_process";
import path from "node:path";

import { minimalRuntimeEnvironment } from "./environment-policy.mjs";

const CACHE_TTL_MS = 2_000;
const COMMAND_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ROWS = 64;
const MAX_CANDIDATES = 8;
const REASONS = new Set(["unsupported_platform", "no_eligible_network", "public_network", "probe_failed", "invalid_result"]);

// This command is deliberately closed over: no renderer, profile, adapter, or address
// input is interpolated into it. Get-NetConnectionProfile describes physical connection
// profiles; Get-NetAdapter -Physical supplies only active wired/Wi-Fi hardware; the
// address rows are then matched by InterfaceIndex in this module.
const WINDOWS_LAN_PROBE = [
  "$ErrorActionPreference = 'Stop'",
  "$profiles = @(Get-NetConnectionProfile | Select-Object @{ n = 'InterfaceIndex'; e = { [uint32]$_.InterfaceIndex } }, @{ n = 'ProfileIdentity'; e = { [string]$_.InstanceID } }, @{ n = 'NetworkCategory'; e = { switch ($_.NetworkCategory) { 0 { 'Public' } 1 { 'Private' } 2 { 'DomainAuthenticated' } 'Public' { 'Public' } 'Private' { 'Private' } 'DomainAuthenticated' { 'DomainAuthenticated' } default { 'Unknown' } } } }, @{ n = 'IPv4Connectivity'; e = { switch ($_.IPv4Connectivity) { 2 { 'Subnet' } 3 { 'LocalNetwork' } 4 { 'Internet' } 16 { 'Subnet' } 32 { 'LocalNetwork' } 64 { 'Internet' } 'Subnet' { 'Subnet' } 'LocalNetwork' { 'LocalNetwork' } 'Internet' { 'Internet' } default { 'Other' } } } })",
  "$adapters = @(Get-NetAdapter -Physical | ForEach-Object { $media = switch ($_.MediaType) { 0 { '802.3' } 16 { 'Native 802.11' } '802.3' { '802.3' } 'Native 802.11' { 'Native 802.11' } default { 'Other' } }; $status = if ($_.Status -eq 1 -or $_.Status -eq 'Up') { 'Up' } else { 'Other' }; if ($status -eq 'Up' -and $_.HardwareInterface -eq $true -and ($media -eq '802.3' -or $media -eq 'Native 802.11')) { [PSCustomObject]@{ InterfaceIndex = [uint32]$_.ifIndex; Name = [string]$_.Name; Status = $status; HardwareInterface = [bool]$_.HardwareInterface; MediaType = $media } } })",
  "$addresses = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $state = switch ($_.AddressState) { 4 { 'Preferred' } 'Preferred' { 'Preferred' } default { 'Other' } }; if ($state -eq 'Preferred' -and $_.SkipAsSource -eq $false) { [PSCustomObject]@{ InterfaceIndex = [uint32]$_.InterfaceIndex; IPAddress = [string]$_.IPAddress; PrefixLength = [int]$_.PrefixLength; AddressState = $state; SkipAsSource = [bool]$_.SkipAsSource } } })",
  "[PSCustomObject]@{ Profiles = $profiles; Adapters = $adapters; Addresses = $addresses } | ConvertTo-Json -Compress -Depth 4",
].join("; ");

function environmentValue(environment, name) {
  if (!environment || typeof environment !== "object") return undefined;
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

function safeSystemRoot(environment) {
  for (const name of ["SystemRoot", "WINDIR"]) {
    const value = environmentValue(environment, name);
    if (typeof value !== "string" || !value || /[\u0000\r\n"]/u.test(value) || !path.win32.isAbsolute(value)) continue;
    const normalized = path.win32.normalize(value);
    if (normalized !== "." && normalized !== path.win32.parse(normalized).root && !normalized.includes("..")) return normalized;
  }
  return null;
}

export function resolveWindowsPowerShellExecutable(environment = process.env) {
  const systemRoot = safeSystemRoot(environment);
  return systemRoot ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
}

function ipv4Parts(value) {
  if (typeof value !== "string" || value.length < 7 || value.length > 15 || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function prefixMask(prefix) {
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 30) return null;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function maskToString(mask) {
  return [mask >>> 24, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join(".");
}

export function isPrivateIPv4(address) {
  const parts = ipv4Parts(address);
  return Boolean(parts && (
    parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
  ));
}

function boundedLabel(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const label = value.replace(/\s+/gu, " ").trim();
  return label && label.length <= 96 ? label : null;
}

function boundedIndex(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : null;
}

function fixedReason(reason) {
  return REASONS.has(reason) ? reason : "invalid_result";
}

function unavailable(reason) {
  return Object.freeze({ status: "unavailable", candidates: Object.freeze([]), reason: fixedReason(reason) });
}

function boundedProfileIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value : null;
}

function opaqueCandidateId(index, address, prefix, profileIdentity) {
  const digest = createHash("sha256").update(`${index}|${address}|${prefix}|${profileIdentity}`, "utf8").digest("base64url").slice(0, 18);
  return `lan-${digest}`;
}

function rows(value) {
  return Array.isArray(value) && value.length <= MAX_ROWS ? value : null;
}

function uniqueByIndex(records, check) {
  const mapped = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const index = boundedIndex(record.InterfaceIndex);
    if (index === null || !check(record) || mapped.has(index)) return null;
    mapped.set(index, record);
  }
  return mapped;
}

function normalizeProbe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profiles = rows(value.Profiles);
  const adapters = rows(value.Adapters);
  const addresses = rows(value.Addresses);
  if (!profiles || !adapters || !addresses) return null;

  const profileByIndex = uniqueByIndex(profiles, (profile) => boundedProfileIdentity(profile.ProfileIdentity) !== null
    && ["Private", "Public", "DomainAuthenticated"].includes(profile.NetworkCategory)
    && typeof profile.IPv4Connectivity === "string" && profile.IPv4Connectivity.length <= 32);
  const adapterByIndex = uniqueByIndex(adapters, (adapter) => typeof adapter.Status === "string"
    && typeof adapter.HardwareInterface === "boolean"
    && typeof adapter.MediaType === "string"
    && boundedLabel(adapter.Name) !== null);
  if (!profileByIndex || !adapterByIndex) return null;

  const locallyConnected = (profile) => profile
    && (profile.IPv4Connectivity === "Subnet" || profile.IPv4Connectivity === "LocalNetwork" || profile.IPv4Connectivity === "Internet");
  const physicalAdapter = (adapter) => adapter && adapter.Status === "Up" && adapter.HardwareInterface === true
    && (adapter.MediaType === "802.3" || adapter.MediaType === "Native 802.11");
  const eligibleInterface = (index) => {
    const profile = profileByIndex.get(index);
    const adapter = adapterByIndex.get(index);
    return Boolean(profile?.NetworkCategory === "Private" && locallyConnected(profile) && physicalAdapter(adapter));
  };
  const publicInterface = (index) => {
    const profile = profileByIndex.get(index);
    return Boolean(profile?.NetworkCategory === "Public" && locallyConnected(profile) && physicalAdapter(adapterByIndex.get(index)));
  };

  const privateAddresses = new Map();
  let hasPublicNetwork = false;
  for (const entry of addresses) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const index = boundedIndex(entry.InterfaceIndex);
    const prefix = entry.PrefixLength;
    if (index === null) return null;
    if (!eligibleInterface(index) && !publicInterface(index)) continue;
    if (entry.AddressState !== "Preferred" || entry.SkipAsSource !== false
      || prefixMask(prefix) === null || !ipv4Parts(entry.IPAddress)) return null;
    if (!isPrivateIPv4(entry.IPAddress)) continue;
    if (publicInterface(index)) {
      hasPublicNetwork = true;
      continue;
    }
    if (privateAddresses.has(index)) return null;
    privateAddresses.set(index, entry);
  }

  const candidates = [];
  for (const [index, profile] of profileByIndex) {
    const adapter = adapterByIndex.get(index);
    const address = privateAddresses.get(index);
    if (!adapter || !address || !eligibleInterface(index)) continue;
    const label = boundedLabel(adapter.Name);
    const mask = prefixMask(address.PrefixLength);
    if (!label || mask === null) return null;
    candidates.push(Object.freeze({
      id: opaqueCandidateId(index, address.IPAddress, address.PrefixLength, profile.ProfileIdentity),
      address: address.IPAddress,
      subnetMask: maskToString(mask),
      label,
    }));
  }
  if (candidates.length > MAX_CANDIDATES) return null;
  candidates.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({ candidates: Object.freeze(candidates), hasPublicNetwork });
}

function runProbe(execFileFn, executable, environment) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      execFileFn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command", WINDOWS_LAN_PROBE], {
        encoding: "utf8",
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        env: minimalRuntimeEnvironment(environment),
      }, (error, stdout, stderr) => {
        if (error || stderr || typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
          finish(null);
          return;
        }
        try { finish(JSON.parse(stdout)); } catch { finish(null); }
      });
    } catch { finish(null); }
  });
}

export function createLanNetworkReader(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const execFileFn = options.execFileFn ?? defaultExecFile;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) && options.cacheTtlMs >= 0
    ? Math.min(options.cacheTtlMs, CACHE_TTL_MS) : CACHE_TTL_MS;
  let cached = null;
  let pending = null;

  async function acquire() {
    if (platform !== "win32") return unavailable("unsupported_platform");
    const executable = resolveWindowsPowerShellExecutable(environment);
    if (!executable || typeof execFileFn !== "function") return unavailable("probe_failed");
    const raw = await runProbe(execFileFn, executable, environment);
    if (raw === null) return unavailable("probe_failed");
    const normalized = normalizeProbe(raw);
    if (normalized === null) return unavailable("invalid_result");
    const { candidates, hasPublicNetwork } = normalized;
    if (candidates.length === 0 && hasPublicNetwork) return unavailable("public_network");
    if (candidates.length === 0) return unavailable("no_eligible_network");
    return Object.freeze({ status: candidates.length === 1 ? "available" : "ambiguous", candidates });
  }

  async function read({ force = false } = {}) {
    const observedAt = now();
    if (!force && cached && observedAt - cached.observedAt >= 0 && observedAt - cached.observedAt <= cacheTtlMs) return cached.value;
    if (pending) return pending;
    pending = acquire().then((value) => {
      cached = Object.freeze({ observedAt: now(), value });
      return value;
    }).catch(() => unavailable("probe_failed")).finally(() => { pending = null; });
    return pending;
  }

  return Object.freeze({ read });
}
