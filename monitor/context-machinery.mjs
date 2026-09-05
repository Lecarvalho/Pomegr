import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const MAX_CONTEXT_OUTPUT_CHARS = 100_000;
const MAX_GROUPS = 12;
const MAX_ITEMS_PER_GROUP = 250;
const NON_MACHINERY_CATEGORIES = new Set(["messages", "free space"]);
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

function safeLabel(value, fallback = "Unknown") {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 140 || !/^[\p{L}\p{N}@:+_.() /\\-]+$/u.test(normalized)) return fallback;
  return normalized;
}

function safeTokenLabel(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/^<\s+/, "< ");
  return /^(?:~|< )?\d+(?:\.\d+)?[kKmM]?$/.test(normalized) ? normalized : "";
}

function tokenCount(value) {
  const match = value.match(/^(?:~|< )?(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!match) return 0;
  const multiplier = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function safePercentage(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
  return match ? Number(match[1]) : null;
}

function safeMemoryName(value) {
  const normalized = safeLabel(value, "Memory file").replaceAll("\\", "/");
  return safeLabel(path.posix.basename(normalized), "Memory file");
}

function renderedContextOutput(content) {
  return content.replace(ANSI_ESCAPE, "");
}

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function markdownTables(lines) {
  const tables = [];
  let heading = "Details";
  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = lines[index].trim().match(/^###\s+(.+)$/);
    if (headingMatch) {
      heading = safeLabel(headingMatch[1], "Details");
      continue;
    }
    const headers = tableCells(lines[index]);
    const separator = index + 1 < lines.length ? tableCells(lines[index + 1]) : null;
    if (!headers || !separator || separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const rows = [];
    for (index += 2; index < lines.length; index += 1) {
      const cells = tableCells(lines[index]);
      if (!cells || cells.length !== headers.length) break;
      rows.push(cells);
    }
    tables.push({ heading, headers, rows });
  }
  return tables;
}

function normalizedItems(table) {
  const tokenIndex = table.headers.findIndex((header) => header.toLowerCase() === "tokens");
  if (tokenIndex < 0 || table.headers.length < 2) return [];
  const valueIndexes = table.headers.map((_, index) => index).filter((index) => index !== tokenIndex);
  const pathIndex = valueIndexes.find((index) => table.headers[index].toLowerCase() === "path");
  return table.rows.slice(0, MAX_ITEMS_PER_GROUP).flatMap((cells) => {
    const tokens = safeTokenLabel(cells[tokenIndex]);
    if (!tokens) return [];
    const nameIndex = pathIndex ?? valueIndexes[0];
    const detailIndex = valueIndexes.find((index) => index !== nameIndex);
    const name = table.headers[nameIndex]?.toLowerCase() === "path"
      ? safeMemoryName(cells[nameIndex])
      : safeLabel(cells[nameIndex]);
    const detail = table.headers[detailIndex]?.toLowerCase() === "path"
      ? safeMemoryName(cells[detailIndex])
      : safeLabel(cells[detailIndex]);
    return [{
      name,
      detail,
      tokens,
    }];
  });
}

function groupId(label, index) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  return `${slug || "machinery"}-${index}`;
}

function normalizedCategories(table) {
  const categoryIndex = table.headers.findIndex((header) => header.toLowerCase() === "category");
  const tokenIndex = table.headers.findIndex((header) => header.toLowerCase() === "tokens");
  const percentageIndex = table.headers.findIndex((header) => header.toLowerCase() === "percentage");
  return table.rows.flatMap((cells) => {
    const name = safeLabel(cells[categoryIndex], "");
    const tokens = safeTokenLabel(cells[tokenIndex]);
    const percentage = safePercentage(cells[percentageIndex]);
    if (!name || !tokens || percentage === null || NON_MACHINERY_CATEGORIES.has(name.toLowerCase())) return [];
    return [{ name, tokens, percentage }];
  });
}

function terminalCategories(lines) {
  const categoryLine = /([\p{L}\p{N}@:+_.() /\\-]+?):\s*((?:~|<\s+)?\d+(?:\.\d+)?[kKmM]?)\s*(?:tokens)?\s*\((\d+(?:\.\d+)?)%\)/u;
  return lines.flatMap((line) => {
    const match = line.match(categoryLine);
    if (!match) return [];
    const name = safeLabel(match[1], "");
    const tokens = safeTokenLabel(match[2]);
    const percentage = safePercentage(`${match[3]}%`);
    if (!name || !tokens || percentage === null || NON_MACHINERY_CATEGORIES.has(name.toLowerCase())) return [];
    return [{ name, tokens, percentage }];
  });
}

function contextModel(lines) {
  const labeledModel = lines.find((line) => line.startsWith("**Model:**"));
  if (labeledModel) return safeLabel(labeledModel.replace(/^\*\*Model:\*\*\s*/, ""), "Unknown model");
  const modelMatch = lines.join("\n").match(/\bclaude-[a-z0-9][a-z0-9._-]*\b/i);
  return safeLabel(modelMatch?.[0], "Unknown model");
}

export function contextMachineryFromOutput(output, observedAt = null) {
  if (typeof output !== "string" || output.length > MAX_CONTEXT_OUTPUT_CHARS) return null;
  const content = renderedContextOutput(output);
  if (!/(?:<local-command-stdout>\s*)?(?:##\s+)?Context Usage\b/.test(content)) return null;
  const lines = content.split(/\r?\n/);
  const tables = markdownTables(lines);
  const categoryTable = tables.find((table) => {
    const headers = new Set(table.headers.map((header) => header.toLowerCase()));
    return headers.has("category") && headers.has("tokens") && headers.has("percentage");
  });

  const model = contextModel(lines);
  const totalMatch = content.match(/(?:\*\*Tokens:\*\*\s*)?([0-9.]+[kKmM]?)\s*\/\s*([0-9.]+[kKmM]?)\s*(?:tokens\s*)?\((\d+(?:\.\d+)?)%\)/);
  const categories = categoryTable ? normalizedCategories(categoryTable) : terminalCategories(lines);
  if (!categories.length) return null;

  const groups = tables
    .filter((table) => table !== categoryTable && table.headers.some((header) => header.toLowerCase() === "tokens"))
    .slice(0, MAX_GROUPS)
    .map((table, index) => ({
      id: groupId(table.heading, index),
      label: safeLabel(table.heading, "Machinery"),
      items: normalizedItems(table),
    }))
    .filter((group) => group.items.length > 0);

  return {
    observedAt,
    model,
    total: totalMatch ? { used: totalMatch[1], limit: totalMatch[2], percentage: Number(totalMatch[3]) } : null,
    machineryTokens: categories.reduce((sum, category) => sum + tokenCount(category.tokens), 0),
    categories,
    groups,
  };
}

export function contextMachineryFromNativeJson(output, observedAt = null) {
  if (typeof output !== "string" || output.length > MAX_CONTEXT_OUTPUT_CHARS) return null;
  let envelope;
  try { envelope = JSON.parse(output); } catch { return null; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || typeof envelope.result !== "string" || envelope.result.length > MAX_CONTEXT_OUTPUT_CHARS) return null;
  return contextMachineryFromOutput(envelope.result, observedAt);
}

export function contextMachineryFromRecord(record) {
  if (record?.type !== "system" || record.subtype !== "local_command" || typeof record.content !== "string") return null;
  if (!/<local-command-stdout>\s*(?:##\s+)?Context Usage\b/.test(renderedContextOutput(record.content))) return null;
  return contextMachineryFromOutput(record.content, record.timestamp || null);
}

export function latestContextMachinery(records) {
  let latest = null;
  for (const record of records || []) {
    const snapshot = contextMachineryFromRecord(record);
    if (snapshot) latest = snapshot;
  }
  return latest;
}

export async function readLatestContextMachinery(file) {
  let input;
  try {
    input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let latest = null;
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const snapshot = contextMachineryFromRecord(record);
      if (snapshot) latest = snapshot;
    }
    return latest;
  } catch {
    input?.destroy();
    return null;
  }
}
