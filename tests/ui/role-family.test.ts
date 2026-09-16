import { describe, expect, it } from "vitest";
import type { AgentRole } from "../../shared/monitor-contract";
import { ROLE_FAMILY_BY_ROLE, roleFamilyPresentation } from "../../app/role-family";

describe("agent role-family presentation", () => {
  it("maps every bounded role to the agreed family and token/class", () => {
    const expected: Record<AgentRole, [string, string | null]> = {
      orchestrator: ["neutral", null],
      explore: ["reading", "--role-reading"],
      researcher: ["reading", "--role-reading"],
      plan: ["planning", "--role-planning"],
      builder: ["writing", "--role-writing"],
      tester: ["writing", "--role-writing"],
      reviewer: ["reviewing", "--role-reviewing"],
      "general-purpose": ["generic", "--role-generic"],
      "workflow-worker": ["generic", "--role-generic"],
      fork: ["generic", "--role-generic"],
      compaction: ["system", "--role-system"],
      unknown: ["system", "--role-system"],
    };

    expect(Object.keys(ROLE_FAMILY_BY_ROLE)).toHaveLength(Object.keys(expected).length);
    for (const [role, [family, token]] of Object.entries(expected) as Array<[AgentRole, [string, string | null]]>) {
      expect(roleFamilyPresentation(role)).toEqual({ family, token, className: `roleFamily-${family}` });
    }
  });
});
