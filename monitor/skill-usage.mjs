const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,95}$/;

export function normalizedSkillName(input) {
  if (typeof input?.skill !== "string") return "";
  const name = input.skill.trim();
  return SAFE_SKILL_NAME.test(name) ? name : "";
}

export function buildSkillUsage(records) {
  const usage = new Map();

  for (const record of records) {
    if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) continue;
    for (const content of record.message.content) {
      if (content?.type !== "tool_use" || content.name !== "Skill") continue;
      const name = normalizedSkillName(content.input);
      if (!name) continue;
      const timestamp = record.timestamp || record.message?.timestamp || null;
      const current = usage.get(name) || { name, calls: 0, lastUsed: null };
      current.calls += 1;
      if (timestamp && (!current.lastUsed || new Date(timestamp) > new Date(current.lastUsed))) current.lastUsed = timestamp;
      usage.set(name, current);
    }
  }

  return [...usage.values()].sort((a, b) => {
    const recency = new Date(b.lastUsed || 0).getTime() - new Date(a.lastUsed || 0).getTime();
    return recency || a.name.localeCompare(b.name);
  });
}
