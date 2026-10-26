export const REWORK_CAUSES = ["missed_wiring", "spec_gap", "wrong_behavior", "stale_instructions", "latent", "other"];

export const isReworkReference = (value) => typeof value === "string" && value.trim() === value
  && /^(?:T-|#)[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value.slice(value.startsWith("T-") ? 2 : 1)));

export function validReportReworks(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 5 && value.every((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 2
    && isReworkReference(entry.ref) && REWORK_CAUSES.includes(entry.cause));
}

// Report answers expose only bounded references and fixed outcomes, never record or error contents.
export function reportReworkResults(value) {
  return (Array.isArray(value) ? value : []).slice(0, 5).flatMap((entry) => {
    if (!isReworkReference(entry?.ref)) return [];
    if (["recorded", "exists"].includes(entry.status)) return [{ ref: entry.ref, status: entry.status }];
    return entry.status === "refused" && ["invalid", "not_found", "limit"].includes(entry.reason)
      ? [{ ref: entry.ref, status: "refused", reason: entry.reason }] : [];
  });
}
