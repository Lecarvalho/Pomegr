// Source comparability is deliberately out of band: JSON, structuredClone and
// provider/browser schemas cannot serialize credential-source fingerprints.
const metadata = new WeakMap();
export function withUsageNotificationSource(value, sourceScope, complete = true, windows = null) {
  if (value && typeof value === "object") metadata.set(value, { sourceScope, complete, windows });
  return value;
}
export function usageNotificationSource(value) { return metadata.get(value) ?? null; }
export function copyUsageNotificationSource(source, target) {
  const info = metadata.get(source);
  if (info) metadata.set(target, info);
  return target;
}

export function committedUsageNotificationFacts(committed, sourceValues) {
  return { revision: committed.revision, providers: committed.value.providers.map((entry) => ({
    ...entry, comparison: usageNotificationSource(sourceValues.get(entry.provider)?.usageLimits),
  })) };
}
