import type { ReactNode } from "react";
import type { AgentRole } from "../../../../shared/monitor-contract";
export function RoleGlyph({ role }: { role: AgentRole }) {
  const c = { fill: "none", stroke: "currentColor", strokeLinecap: "square" as const, strokeLinejoin: "miter" as const, strokeWidth: 1.55 };
  const shapes: Record<AgentRole, ReactNode> = {
    orchestrator: <><path {...c} d="m12 2.5 9.5 9.5-9.5 9.5-9.5-9.5L12 2.5Z" /><path {...c} d="M12 7v10M7 12h10" /></>, explore: <><circle {...c} cx="10" cy="10" r="5" /><path {...c} d="m14 14 6 6M5 10h10M10 5v10" /></>, plan: <><path {...c} d="M6 3.5h12v17H6zM9 8h6M9 12h6M9 16h4" /></>, builder: <><path {...c} d="M4 6h16v13H4zM8 6V4h8v2M8 11h8M8 15h5" /></>, reviewer: <><path {...c} d="M5 4h14v16H5zM8 9h8M8 13h5" /><path {...c} d="m8 17 2 2 5-5" /></>, tester: <><path {...c} d="M7 4h10M10 4v6l-4 7h12l-4-7V4" /><path {...c} d="M9 14h6" /></>, researcher: <><path {...c} d="M4 5h11v14H4zM7 9h5M7 13h5" /><path {...c} d="m15 15 5 5" /></>, "general-purpose": <><path {...c} d="M4 4h16v16H4zM4 12h16M12 4v16" /></>, "workflow-worker": <><path {...c} d="M4 5h16v14H4zM8 9h8M8 13h8M8 17h4" /><path {...c} d="M3 8h1M3 16h1" /></>, fork: <><path {...c} d="M6 4v16M6 8h4c3 0 3-3 6-3h2M10 16c3 0 3 3 6 3h2" /><circle {...c} cx="6" cy="4" r="1.5" /><circle {...c} cx="18" cy="5" r="1.5" /><circle {...c} cx="18" cy="19" r="1.5" /></>, compaction: <><path {...c} d="M4 6h16M7 12h10M10 18h4" /><path {...c} d="m15 10 2 2-2 2M9 10l-2 2 2 2" /></>, unknown: <><path {...c} d="M5 4h14v16H5zM9 9c0-2 6-2 6 1 0 2-3 2-3 4" /><path {...c} d="M12 17v.01" /></>,
  };
  return <svg aria-hidden="true" className="agentTreeRoleGlyph" viewBox="0 0 24 24">{shapes[role]}</svg>;
}
