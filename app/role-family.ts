import type { AgentRole } from "../shared/monitor-contract";

/** Fixed presentation families for agent tracks and their legends. */
export type RoleFamily = "neutral" | "reading" | "planning" | "writing" | "reviewing" | "generic" | "system";

export type RoleFamilyPresentation = {
  family: RoleFamily;
  /** CSS custom property name; neutral deliberately has no role token. */
  token: `--role-${Exclude<RoleFamily, "neutral">}` | null;
  className: `roleFamily-${RoleFamily}`;
};

export const ROLE_FAMILY_BY_ROLE: Readonly<Record<AgentRole, RoleFamily>> = {
  orchestrator: "neutral",
  explore: "reading",
  researcher: "reading",
  plan: "planning",
  builder: "writing",
  tester: "writing",
  reviewer: "reviewing",
  "general-purpose": "generic",
  "workflow-worker": "generic",
  fork: "generic",
  compaction: "system",
  unknown: "system",
};

const ROLE_FAMILY_TOKENS: Readonly<Record<Exclude<RoleFamily, "neutral">, `--role-${Exclude<RoleFamily, "neutral">}`>> = {
  reading: "--role-reading",
  planning: "--role-planning",
  writing: "--role-writing",
  reviewing: "--role-reviewing",
  generic: "--role-generic",
  system: "--role-system",
};

export function roleFamilyForRole(role: AgentRole): RoleFamily {
  return ROLE_FAMILY_BY_ROLE[role];
}

export function roleFamilyPresentation(role: AgentRole): RoleFamilyPresentation {
  const family = roleFamilyForRole(role);
  return {
    family,
    token: family === "neutral" ? null : ROLE_FAMILY_TOKENS[family],
    className: `roleFamily-${family}`,
  };
}
