import { agentDisplayName } from "../../../dashboard-utils";
import type { AgentTreeVisualForest } from "./topology";

export function focusPathIds(forest: AgentTreeVisualForest, focusId: string | null) {
  const path = new Set<string>();
  let node = focusId ? forest.byId.get(focusId) : undefined;
  while (node && !path.has(node.id)) {
    path.add(node.id);
    node = node.visualParentId ? forest.byId.get(node.visualParentId) : undefined;
  }
  return path;
}

export function FocusPath({ forest, focusId }: { forest: AgentTreeVisualForest; focusId: string }) {
  const names = [...focusPathIds(forest, focusId)].reverse().map((id) => {
    const node = forest.byId.get(id)!;
    return node.isCluster ? node.label : node.id === "primary" ? "Primary" : agentDisplayName(node.agent);
  });
  if (!names.length) return null;
  return <footer className="agentTreeFocusFooter"><span dir="auto">Focus path: {names.join(" › ")}</span><span>Layout follows provider evidence order · numbers are latest snapshots</span></footer>;
}
