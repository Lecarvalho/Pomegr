// Provider-neutral fold of a bounded live delta into a complete normalized
// session story.

export function chronological(left, right) {
  return Date.parse(left?.timestamp || left?.observedAt || "")
    - Date.parse(right?.timestamp || right?.observedAt || "");
}

// Union two lists by key, resolving a collision with `prefer` (current wins
// by default), then keep only the newest `maximum` in chronological order.
export function mergeByKey(previous, current, keyOf, maximum, prefer = (_older, next) => next) {
  const merged = new Map();
  for (const item of [...(previous || []), ...(current || [])]) {
    const key = keyOf(item);
    if (!key) continue;
    merged.set(key, merged.has(key) ? prefer(merged.get(key), item) : item);
  }
  return [...merged.values()].sort(chronological).slice(-maximum);
}

function pathSegments(field) {
  return field.split(".");
}

function readPath(object, segments) {
  return segments.reduce((value, segment) => (value == null ? undefined : value[segment]), object);
}

function foldOrFlags(previousValue, currentValue) {
  return Object.fromEntries(
    Object.keys(currentValue || {}).map((key) => [key, Boolean(previousValue?.[key] || currentValue?.[key])]),
  );
}

function foldField(field, config, previousValue, currentValue, folded) {
  switch (config.kind) {
    case "keyed":
      return mergeByKey(previousValue, currentValue, config.key, config.maximum, config.prefer);
    case "current":
      return currentValue;
    case "or-flags":
      return foldOrFlags(previousValue, currentValue);
    case "retain-if-absent":
      return currentValue || previousValue || null;
    case "custom": {
      for (const dependency of config.dependsOn || []) {
        if (!(dependency in folded)) {
          throw new Error(`session-fold: field "${field}" depends on unfolded field "${dependency}"; declare it earlier in the policy`);
        }
      }
      return config.merge(previousValue, currentValue, folded);
    }
    default:
      throw new Error(`session-fold: unknown policy kind "${config.kind}" for field "${field}"`);
  }
}

export function foldSessionEvidence(policy, previous, current) {
  if (previous == null) return current;
  const result = { ...current };
  const folded = {};
  const nestedRoots = new Map();
  for (const [field, config] of Object.entries(policy)) {
    const segments = pathSegments(field);
    const previousValue = readPath(previous, segments);
    const currentValue = readPath(current, segments);
    const value = foldField(field, config, previousValue, currentValue, folded);
    if (segments.length === 1) {
      folded[field] = value;
      result[field] = value;
      continue;
    }
    const [root, ...rest] = segments;
    if (!nestedRoots.has(root)) nestedRoots.set(root, { ...current?.[root] });
    let target = nestedRoots.get(root);
    for (let index = 0; index < rest.length - 1; index += 1) {
      const key = rest[index];
      if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
      target = target[key];
    }
    target[rest.at(-1)] = value;
    result[root] = nestedRoots.get(root);
    folded[root] = result[root];
  }
  return result;
}
