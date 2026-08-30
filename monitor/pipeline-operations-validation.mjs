import { z } from "zod";
import {
  providerSessionEvidenceSchema,
  providerSessionReferenceSchema,
  providerUsageLimitsSchema,
} from "./providers/provider-contract.mjs";

const MAX_ISSUES = 8;
const MAX_SCANNED_ISSUES = 64;
const MAX_PATH_DEPTH = 16;
const RULES = new Set([
  "invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of",
  "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom",
]);

// Derive vocabulary from trusted normalized contracts, never rejected input or raw
// provider schemas. Only object, array, optional and nullable shapes are traversed.
const fields = new Set(["$", "unavailable"]);
function collectFields(schema, prefix = "", depth = 0) {
  if (depth > MAX_PATH_DEPTH || prefix.length > 128) return;
  if (prefix) fields.add(prefix);
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape)) {
      if (/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) collectFields(child, prefix ? `${prefix}.${key}` : key, depth + 1);
    }
  } else if (schema instanceof z.ZodArray) {
    collectFields(schema.element, `${prefix}[]`, depth + 1);
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    collectFields(schema.unwrap(), prefix, depth + 1);
  }
}
for (const schema of [providerSessionEvidenceSchema, providerSessionReferenceSchema, providerUsageLimitsSchema]) {
  collectFields(schema);
}

function fieldFromPath(path) {
  if (!Array.isArray(path) || path.length > MAX_PATH_DEPTH) return "unavailable";
  let field = "";
  for (const part of path) {
    if (Number.isSafeInteger(part) && part >= 0) field += "[]";
    else if (typeof part === "string" && part.length <= 128 && /^[A-Za-z][A-Za-z0-9]*$/u.test(part)) {
      field += `${field ? "." : ""}${part}`;
    } else return "unavailable";
    if (field.length > 128) return "unavailable";
  }
  return fields.has(field || "$") ? field || "$" : "unavailable";
}

/** Re-allowlist fixed field/rule pairs at both monitor and CLI boundaries. */
export function normalizeSchemaValidationSummary(value) {
  const input = Array.isArray(value?.issues) ? value.issues : [];
  const issues = [];
  const seen = new Set();
  let truncated = value?.truncated === true || input.length > MAX_SCANNED_ISSUES;
  for (const issue of input.slice(0, MAX_SCANNED_ISSUES)) {
    const field = fields.has(issue?.field) ? issue.field : "unavailable";
    const rule = RULES.has(issue?.rule) ? issue.rule : "unknown";
    const key = `${field}:${rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (issues.length === MAX_ISSUES) { truncated = true; break; }
    issues.push(Object.freeze({ field, rule }));
  }
  return Object.freeze({ issues: Object.freeze(issues), truncated });
}

/** Never retain issue messages, input, unknown keys, enum values, limits or indices. */
export function summarizeSchemaValidationFailure(error) {
  try {
    if (!(error instanceof z.ZodError)) return null;
    const rawIssues = error.issues;
    if (!Array.isArray(rawIssues)) return normalizeSchemaValidationSummary(null);
    return normalizeSchemaValidationSummary({
      issues: rawIssues.slice(0, MAX_SCANNED_ISSUES).map((issue) => ({
        field: fieldFromPath(issue?.path),
        rule: RULES.has(issue?.code) ? issue.code : "unknown",
      })),
      truncated: rawIssues.length > MAX_SCANNED_ISSUES,
    });
  } catch { return null; }
}
