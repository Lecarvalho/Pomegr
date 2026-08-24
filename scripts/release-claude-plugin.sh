#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'Usage: %s <major|minor|patch>\n' "${0##*/}" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 64
fi

increment="$1"
case "$increment" in
  major|minor|patch) ;;
  *)
    usage
    exit 64
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  printf 'Error: Node.js is required.\n' >&2
  exit 69
fi

if ! command -v npm >/dev/null 2>&1; then
  printf 'Error: npm is required.\n' >&2
  exit 69
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/.." && pwd)"
plugin_manifest="$repository_root/plugins/claude-code/.claude-plugin/plugin.json"
plugin_package="$repository_root/plugins/claude-code/package.json"
mcp_server="$repository_root/plugins/claude-code/mcp/server.mjs"
mcp_bundle="$repository_root/plugins/claude-code/mcp/server.bundle.mjs"
rename_script="$repository_root/plugins/claude-code/scripts/rename-session.mjs"
title_contract="$repository_root/plugins/claude-code/scripts/session-title.mjs"
rename_bundle="$repository_root/plugins/claude-code/scripts/rename-session.bundle.mjs"

for required_file in "$plugin_manifest" "$plugin_package" "$mcp_server" "$mcp_bundle" "$rename_script" "$title_contract" "$rename_bundle"; do
  if [[ ! -f "$required_file" ]]; then
    printf 'Error: required file is missing: %s\n' "$required_file" >&2
    exit 66
  fi
done

backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/pomegr-plugin-release.XXXXXX")"
cleanup() {
  rm -f -- \
    "$backup_dir/plugin.json" \
    "$backup_dir/package.json" \
    "$backup_dir/server.mjs" \
    "$backup_dir/server.bundle.mjs" \
    "$backup_dir/rename-session.mjs" \
    "$backup_dir/session-title.mjs" \
    "$backup_dir/rename-session.bundle.mjs"
  rmdir -- "$backup_dir"
}
trap cleanup EXIT

cp -- "$plugin_manifest" "$backup_dir/plugin.json"
cp -- "$plugin_package" "$backup_dir/package.json"
cp -- "$mcp_server" "$backup_dir/server.mjs"
cp -- "$mcp_bundle" "$backup_dir/server.bundle.mjs"
cp -- "$rename_script" "$backup_dir/rename-session.mjs"
cp -- "$title_contract" "$backup_dir/session-title.mjs"
cp -- "$rename_bundle" "$backup_dir/rename-session.bundle.mjs"

restore_release_files() {
  cp -- "$backup_dir/plugin.json" "$plugin_manifest"
  cp -- "$backup_dir/package.json" "$plugin_package"
  cp -- "$backup_dir/server.mjs" "$mcp_server"
  cp -- "$backup_dir/server.bundle.mjs" "$mcp_bundle"
  cp -- "$backup_dir/rename-session.mjs" "$rename_script"
  cp -- "$backup_dir/session-title.mjs" "$title_contract"
  cp -- "$backup_dir/rename-session.bundle.mjs" "$rename_bundle"
}

if ! version_transition="$(node --input-type=module - "$plugin_manifest" "$plugin_package" "$mcp_server" "$increment" <<'NODE'
import fs from "node:fs";

const [, , manifestPath, packagePath, serverPath, increment] = process.argv;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readManifest(file) {
  const text = fs.readFileSync(file, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  if (typeof value.version !== "string" || !semverPattern.test(value.version)) {
    throw new Error(`${file} must contain a strict numeric semantic version.`);
  }
  return { text, version: value.version };
}

function replaceOnce(text, expected, replacement, file) {
  const first = text.indexOf(expected);
  if (first < 0 || text.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`${file} must contain exactly one expected version marker.`);
  }
  return `${text.slice(0, first)}${replacement}${text.slice(first + expected.length)}`;
}

const manifest = readManifest(manifestPath);
const packageManifest = readManifest(packagePath);
if (manifest.version !== packageManifest.version) {
  throw new Error(`Plugin versions are out of sync: ${manifest.version} and ${packageManifest.version}.`);
}

const currentVersion = manifest.version;
const parts = currentVersion.split(".").map(Number);
if (increment === "major") {
  parts[0] += 1;
  parts[1] = 0;
  parts[2] = 0;
} else if (increment === "minor") {
  parts[1] += 1;
  parts[2] = 0;
} else {
  parts[2] += 1;
}
const nextVersion = parts.join(".");

const serverText = fs.readFileSync(serverPath, "utf8");
const serverMarker = `{ name: "pomegr", version: "${currentVersion}" }`;
const nextServerMarker = `{ name: "pomegr", version: "${nextVersion}" }`;

const nextManifest = replaceOnce(
  manifest.text,
  `"version": "${currentVersion}"`,
  `"version": "${nextVersion}"`,
  manifestPath,
);
const nextPackage = replaceOnce(
  packageManifest.text,
  `"version": "${currentVersion}"`,
  `"version": "${nextVersion}"`,
  packagePath,
);
const nextServer = replaceOnce(serverText, serverMarker, nextServerMarker, serverPath);

fs.writeFileSync(manifestPath, nextManifest, "utf8");
fs.writeFileSync(packagePath, nextPackage, "utf8");
fs.writeFileSync(serverPath, nextServer, "utf8");
process.stdout.write(`${currentVersion} -> ${nextVersion}`);
NODE
)"; then
  restore_release_files
  printf 'Error: version bump failed; release files were restored.\n' >&2
  exit 1
fi

if ! (cd -- "$repository_root" && npm run build:plugin); then
  restore_release_files
  printf 'Error: plugin build failed; release files were restored.\n' >&2
  exit 1
fi

printf '\nPomegr Claude plugin prepared: %s\n' "$version_transition"
printf 'Updated both plugin manifests, synchronized the MCP server version, and rebuilt the MCP and rename-hook bundles.\n'
printf '\nAfter this release is committed and pushed, each project-scope client must run:\n\n'
printf '  /plugin marketplace update pomegr\n'
printf '  claude plugin update pomegr@pomegr --scope project\n'
printf '  /reload-plugins\n'
printf '  /pomegr:init\n'
printf '\nThe marketplace name is pomegr; the plugin identifier is pomegr@pomegr.\n'
