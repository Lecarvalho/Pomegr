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

claude_manifest="$repository_root/plugins/claude-code/.claude-plugin/plugin.json"
claude_package="$repository_root/plugins/claude-code/package.json"
codex_manifest="$repository_root/plugins/pomegr/.codex-plugin/plugin.json"
claude_server="$repository_root/plugins/claude-code/mcp/server.mjs"
codex_server="$repository_root/mcp/server.mjs"
claude_bundle="$repository_root/plugins/claude-code/mcp/server.bundle.mjs"
codex_bundle="$repository_root/plugins/pomegr/mcp/server.bundle.mjs"
rename_script="$repository_root/plugins/claude-code/scripts/rename-session.mjs"
title_contract="$repository_root/plugins/claude-code/scripts/session-title.mjs"
rename_bundle="$repository_root/plugins/claude-code/scripts/rename-session.bundle.mjs"

version_manifests=("$claude_manifest" "$claude_package" "$codex_manifest")
mcp_servers=("$claude_server" "$codex_server")
release_files=(
  "${version_manifests[@]}"
  "${mcp_servers[@]}"
  "$claude_bundle"
  "$codex_bundle"
  "$rename_script"
  "$title_contract"
  "$rename_bundle"
)

for required_file in "${release_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    printf 'Error: required file is missing: %s\n' "$required_file" >&2
    exit 66
  fi
done

backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/pomegr-plugin-release.XXXXXX")"
backup_files=()

cleanup() {
  if [[ ${#backup_files[@]} -gt 0 ]]; then
    rm -f -- "${backup_files[@]}"
  fi
  rmdir -- "$backup_dir"
}
trap cleanup EXIT

for index in "${!release_files[@]}"; do
  backup_file="$backup_dir/$index"
  cp -- "${release_files[$index]}" "$backup_file"
  backup_files+=("$backup_file")
done

restore_release_files() {
  for index in "${!release_files[@]}"; do
    cp -- "${backup_files[$index]}" "${release_files[$index]}"
  done
}

if ! version_transition="$(node --input-type=module - "$increment" "$claude_server" "$codex_server" "${version_manifests[@]}" <<'NODE'
import fs from "node:fs";

const [, , increment, claudeServerPath, codexServerPath, ...manifestPaths] = process.argv;
const serverPaths = [claudeServerPath, codexServerPath];
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
  return { file, text, version: value.version };
}

function replaceOnce(text, expected, replacement, file) {
  const first = text.indexOf(expected);
  if (first < 0 || text.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`${file} must contain exactly one expected version marker.`);
  }
  return `${text.slice(0, first)}${replacement}${text.slice(first + expected.length)}`;
}

const manifests = manifestPaths.map(readManifest);
const currentVersion = manifests[0]?.version;
if (!currentVersion) {
  throw new Error("At least one plugin manifest is required.");
}
for (const manifest of manifests.slice(1)) {
  if (manifest.version !== currentVersion) {
    throw new Error(`Plugin versions are out of sync: ${currentVersion} and ${manifest.version}.`);
  }
}

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

const nextServers = serverPaths.map((serverPath) => {
  const serverText = fs.readFileSync(serverPath, "utf8");
  return {
    file: serverPath,
    text: replaceOnce(
      serverText,
      `{ name: "pomegr", version: "${currentVersion}" }`,
      `{ name: "pomegr", version: "${nextVersion}" }`,
      serverPath,
    ),
  };
});

for (const manifest of manifests) {
  const nextManifest = replaceOnce(
    manifest.text,
    `"version": "${currentVersion}"`,
    `"version": "${nextVersion}"`,
    manifest.file,
  );
  fs.writeFileSync(manifest.file, nextManifest, "utf8");
}
for (const server of nextServers) {
  fs.writeFileSync(server.file, server.text, "utf8");
}
process.stdout.write(`${currentVersion} -> ${nextVersion}`);
NODE
)"; then
  restore_release_files
  printf 'Error: plugin version bump failed; release files were restored.\n' >&2
  exit 1
fi

if ! (cd -- "$repository_root" && npm run build:plugin); then
  restore_release_files
  printf 'Error: plugin build failed; release files were restored.\n' >&2
  exit 1
fi

printf '\nPomegr plugins prepared: %s\n' "$version_transition"
printf 'Updated the shared Claude and Codex plugin version, synchronized both MCP servers, and rebuilt both provider packages.\n'
printf '\nAfter this release is committed and pushed, Claude Code project-scope clients must run:\n\n'
printf '  /plugin marketplace update pomegr\n'
printf '  claude plugin update pomegr@pomegr --scope project\n'
printf '  /reload-plugins\n'
printf '  /pomegr:init\n'
printf '\nCodex clients must run:\n\n'
printf '  codex plugin marketplace upgrade pomegr\n'
printf '  codex plugin add pomegr@pomegr\n'
printf '\nThen review and trust Pomegr in /hooks and start a new Codex task.\n'
printf '\nThe marketplace name is pomegr; the plugin identifier is pomegr@pomegr.\n'
