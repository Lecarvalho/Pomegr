import fs from "node:fs";
import path from "node:path";

export function walkJsonl(root, maxDepth = 6, depth = 0) {
  if (!root || !fs.existsSync(root) || depth > maxDepth) return [];
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...walkJsonl(full, maxDepth, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(full);
  }
  return results;
}

export function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

export function findLatestSession(projectsRoot, explicitSession) {
  if (explicitSession && fs.existsSync(explicitSession)) return explicitSession;

  const marker = `${path.sep}subagents${path.sep}`;
  const primaryFiles = [];
  const activityByPrimary = new Map();

  for (const file of walkJsonl(projectsRoot)) {
    const stat = statSafe(file);
    if (!stat) continue;
    const markerIndex = file.indexOf(marker);
    const primaryFile = markerIndex >= 0
      ? `${file.slice(0, markerIndex)}.jsonl`
      : file;

    if (markerIndex < 0) primaryFiles.push(file);
    activityByPrimary.set(
      primaryFile,
      Math.max(activityByPrimary.get(primaryFile) || 0, stat.mtimeMs),
    );
  }

  return primaryFiles
    .sort((a, b) => (activityByPrimary.get(b) || 0) - (activityByPrimary.get(a) || 0))[0] || null;
}
