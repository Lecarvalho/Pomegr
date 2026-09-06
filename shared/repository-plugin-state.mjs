import { z } from "zod";

export const pluginVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,64})?$/u);
const timestamp = z.string().datetime().nullable();
export const repositoryPluginSetupSchema = z.object({
  readiness: z.enum(["loading", "ready", "unavailable"]),
  installation: z.enum(["installed", "not_installed", "unknown"]),
  version: pluginVersionSchema.nullable(), enabled: z.boolean().nullable(),
  scope: z.enum(["user", "project", "local"]).nullable(), checkedAt: timestamp,
  update: z.object({ status: z.enum(["current", "available", "pinned", "unavailable", "unknown"]), version: pluginVersionSchema.nullable(), checkedAt: timestamp }).strict(),
  canInstall: z.boolean(), canUpdate: z.boolean(),
}).strict();
export const repositoryReportingSchema = z.object({
  status: z.enum(["configured", "missing", "invalid", "unknown"]),
  version: z.number().int().min(1).max(99).nullable(), checkedAt: timestamp,
}).strict();
export function emptyRepositoryPluginSetup(readiness = "loading") {
  return { readiness, installation: "unknown", version: null, enabled: null, scope: null, checkedAt: null,
    update: { status: "unknown", version: null, checkedAt: null }, canInstall: false, canUpdate: false };
}
export function comparePluginVersions(left, right) {
  if (!pluginVersionSchema.safeParse(left).success || !pluginVersionSchema.safeParse(right).success) return null;
  const [a, ap] = left.split(/-(.*)/u); const [b, bp] = right.split(/-(.*)/u);
  const av = a.split(".").map(Number); const bv = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (av[index] !== bv[index]) return Math.sign(av[index] - bv[index]);
  if (ap === bp) return 0;
  if (!ap || !bp) return ap ? -1 : 1;
  const aa = ap.split("."); const bb = bp.split(".");
  for (let index = 0; index < Math.max(aa.length, bb.length); index++) {
    if (aa[index] === undefined || bb[index] === undefined) return aa[index] === undefined ? -1 : 1;
    if (aa[index] === bb[index]) continue;
    const an = /^\d+$/u.test(aa[index]); const bn = /^\d+$/u.test(bb[index]);
    if (an && bn) return Math.sign(Number(aa[index]) - Number(bb[index]));
    if (an !== bn) return an ? -1 : 1;
    return aa[index] < bb[index] ? -1 : 1;
  }
  return 0;
}
