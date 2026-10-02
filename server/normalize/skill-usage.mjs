const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,95}$/;

export function normalizedSkillName(input) {
  if (typeof input?.skill !== "string") return "";
  const name = input.skill.trim();
  return SAFE_SKILL_NAME.test(name) ? name : "";
}

export function buildSkillUsageFromInvocations(invocations = []) {
  const usage = new Map();

  for (const invocation of invocations) {
    const name = normalizedSkillName({ skill: invocation?.name });
    if (!name) continue;
    const timestamp = typeof invocation?.timestamp === "string"
      && Number.isFinite(Date.parse(invocation.timestamp))
      ? invocation.timestamp
      : null;
    const current = usage.get(name) || { name, calls: 0, lastUsed: null };
    current.calls += 1;
    if (timestamp && (!current.lastUsed || Date.parse(timestamp) >= Date.parse(current.lastUsed))) {
      current.lastUsed = timestamp;
    }
    usage.set(name, current);
  }

  return [...usage.values()].sort((a, b) => {
    const recency = new Date(b.lastUsed || 0).getTime() - new Date(a.lastUsed || 0).getTime();
    return recency || a.name.localeCompare(b.name);
  });
}

/** The recorded Skill invocations of one transcript record: validated name and record time only. */
export function skillInvocations(record) {
  if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return [];
  const invocations = [];
  for (const content of record.message.content) {
    if (content?.type !== "tool_use" || content.name !== "Skill") continue;
    const name = normalizedSkillName(content.input);
    if (!name) continue;
    invocations.push({ name, timestamp: record.timestamp || record.message?.timestamp || null });
  }
  return invocations;
}

export function buildSkillUsage(records) {
  return buildSkillUsageFromInvocations(records.flatMap(skillInvocations));
}

const MAX_SKILLS = 256;

/**
 * Running skill usage for a whole-transcript pass: one `{ calls, lastUsed }` per validated skill
 * name, at most 256 names. Returns the same state when the record invokes no skill, and a new one
 * otherwise, so a rejected observation never alters a committed state.
 */
export function reduceSkillUsage(state, record) {
  const invocations = skillInvocations(record);
  if (!invocations.length) return state;
  const next = { ...state };
  for (const { name, timestamp } of invocations) {
    const current = next[name];
    if (!current && Object.keys(next).length >= MAX_SKILLS) continue;
    const valid = typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
    const lastUsed = valid && (!current?.lastUsed || Date.parse(valid) >= Date.parse(current.lastUsed)) ? valid : current?.lastUsed || null;
    next[name] = { calls: (current?.calls || 0) + 1, lastUsed };
  }
  return next;
}

/** The running state in the order `buildSkillUsage` returns: most recently used first, then by name. */
export function skillUsageFromState(state) {
  return Object.entries(state || {}).map(([name, value]) => ({ name, calls: value.calls, lastUsed: value.lastUsed })).sort((a, b) => {
    const recency = new Date(b.lastUsed || 0).getTime() - new Date(a.lastUsed || 0).getTime();
    return recency || a.name.localeCompare(b.name);
  });
}
