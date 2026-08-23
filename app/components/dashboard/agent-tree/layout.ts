import type { AgentTreeForest, AgentTreeNode, AgentTreeVisualForest } from "./topology";

export type LayoutRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  width: number;
  height: number;
  depth: number;
};

export type ContentBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type LayoutMap = Map<string, LayoutRect> & {
  byId: Map<string, LayoutRect>;
  bounds: ContentBounds;
  width: number;
  height: number;
  [id: string]: unknown;
};

export type LayoutNode = {
  id: string;
  parentId: string | null;
  canonicalParentId?: string | null;
  visualParentId?: string | null;
  children: LayoutNode[];
  depth: number;
  visible?: boolean;
};
export type LayoutForest = AgentTreeForest | AgentTreeVisualForest;

export type ColumnLayoutOptions = {
  tileWidth?: number;
  tileHeight?: number;
  columnGap?: number;
  rowGap?: number;
  padding?: number;
  collapsedIds?: Iterable<string>;
  visibleIds?: Iterable<string>;
};

export type RailLayoutOptions = {
  width?: number;
  rowHeight?: number;
  indent?: number;
  narrowIndent?: number;
  narrowWidth?: number;
  padding?: number;
  maxDepth?: number;
  collapsedIds?: Iterable<string>;
  visibleIds?: Iterable<string>;
};

function asNodeList(input: LayoutForest | AgentTreeNode[] | LayoutNode[]) {
  if (Array.isArray(input)) return input as LayoutNode[];
  return input.nodes as LayoutNode[];
}

function rootsFor(nodes: LayoutNode[], root?: string | LayoutNode | null) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (typeof root === "string") {
    const found = byId.get(root);
    return found ? [found] : [];
  }
  if (root && typeof root === "object") return [root as LayoutNode];
  return nodes.filter((node) => {
    // Topology has already detached invalid/cyclic edges. Use that canonical
    // edge when available so a cycle member is still laid out as a root.
    const canonicalParentId = node.visualParentId === undefined ? (node.canonicalParentId === undefined ? node.parentId : node.canonicalParentId) : node.visualParentId;
    return !canonicalParentId || !byId.has(canonicalParentId);
  });
}

function visibleChildren(node: LayoutNode, collapsed: Set<string>, visibleIds?: Set<string>) {
  if (collapsed.has(node.id)) return [];
  return node.children.filter((child) => !visibleIds || visibleIds.has(child.id));
}

function createLayoutMap(rects: Map<string, LayoutRect>, bounds: ContentBounds): LayoutMap {
  const result = rects as LayoutMap;
  result.byId = rects;
  result.bounds = bounds;
  result.width = bounds.width;
  result.height = bounds.height;
  for (const [id, rect] of rects) result[id] = rect;
  return result;
}

function boundsForRects(rects: Map<string, LayoutRect>): ContentBounds {
  return contentBounds(rects);
}

/**
 * Lay out a forest in columns. The x-axis is depth; sibling subtrees are stacked
 * deterministically, and a parent is centered over its visible children.
 */
export function layoutColumns(
  input: LayoutForest | AgentTreeNode[] | LayoutNode[],
  rootOrOptions: string | LayoutNode | ColumnLayoutOptions | null = null,
  maybeOptions: ColumnLayoutOptions = {},
): LayoutMap {
  const options = (rootOrOptions && typeof rootOrOptions === "object" && !("id" in rootOrOptions))
    ? rootOrOptions as ColumnLayoutOptions
    : maybeOptions;
  const root = typeof rootOrOptions === "string" || (rootOrOptions && "id" in rootOrOptions) ? rootOrOptions : null;
  const tileWidth = options.tileWidth ?? 156;
  const tileHeight = options.tileHeight ?? 140;
  const columnGap = options.columnGap ?? 32;
  const rowGap = options.rowGap ?? 24;
  const padding = options.padding ?? 24;
  const collapsed = new Set(options.collapsedIds || []);
  const visibleIds = options.visibleIds && new Set(options.visibleIds);
  const roots = rootsFor(asNodeList(input), root as string | LayoutNode | null);
  const rects = new Map<string, LayoutRect>();
  const byId = new Map(asNodeList(input).map((node) => [node.id, node]));
  const occupied = new Map<number, number>();
  const reserve = (depth: number, desiredTop: number) => {
    const top = Math.max(desiredTop, occupied.get(depth) ?? desiredTop);
    occupied.set(depth, top + tileHeight + rowGap);
    return top;
  };
  const place = (node: LayoutNode, depth: number, desiredTop: number): { top: number; bottom: number } => {
    const children = visibleChildren(node, collapsed, visibleIds).filter((child) => byId.has(child.id));
    if (!children.length) {
      const top = reserve(depth, desiredTop);
      rects.set(node.id, { x: padding + depth * (tileWidth + columnGap), y: top, w: tileWidth, h: tileHeight, width: tileWidth, height: tileHeight, depth });
      return { top, bottom: top + tileHeight };
    }
    const childPlaced = children.map((child) => place(child, depth + 1, desiredTop));
    const childTop = Math.min(...childPlaced.map(({ top }) => top));
    const childBottom = Math.max(...childPlaced.map(({ bottom }) => bottom));
    const desired = (childTop + childBottom - tileHeight) / 2;
    const top = reserve(depth, Math.max(desired, desiredTop));
    rects.set(node.id, { x: padding + depth * (tileWidth + columnGap), y: top, w: tileWidth, h: tileHeight, width: tileWidth, height: tileHeight, depth });
    return { top: Math.min(top, childTop), bottom: Math.max(top + tileHeight, childBottom) };
  };
  let nextRootTop = padding;
  for (const rootNode of roots) {
    const placed = place(rootNode, 0, nextRootTop);
    nextRootTop = Math.max(nextRootTop, placed.bottom + rowGap);
  }
  return createLayoutMap(rects, boundsForRects(rects));
}

/** Lay out visible nodes as fixed-height indented rows for narrow containers. */
export function layoutRail(
  input: LayoutForest | AgentTreeNode[] | LayoutNode[],
  options: RailLayoutOptions = {},
): LayoutMap {
  const nodes = asNodeList(input);
  const width = Math.max(0, options.width ?? 390);
  const rowHeight = options.rowHeight ?? 48;
  const indent = width < (options.narrowWidth ?? 400) ? options.narrowIndent ?? 15 : options.indent ?? 20;
  const padding = options.padding ?? 0;
  const maxDepth = options.maxDepth ?? 7;
  const collapsed = new Set(options.collapsedIds || []);
  const visibleIds = options.visibleIds && new Set(options.visibleIds);
  const roots = rootsFor(nodes);
  const rects = new Map<string, LayoutRect>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let row = 0;
  const visit = (node: LayoutNode, depth: number) => {
    if (visibleIds && !visibleIds.has(node.id)) return;
    const depthForDisplay = Math.min(maxDepth, Math.max(0, depth));
    const x = padding + depthForDisplay * indent;
    const w = Math.max(0, width - x - padding);
    rects.set(node.id, { x, y: padding + row * rowHeight, w, h: rowHeight, width: w, height: rowHeight, depth: depthForDisplay });
    row += 1;
    if (collapsed.has(node.id)) return;
    for (const child of node.children) if (byId.has(child.id)) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return createLayoutMap(rects, boundsForRects(rects));
}

export function contentBounds(input: Map<string, LayoutRect> | LayoutRect[] | Record<string, LayoutRect>): ContentBounds {
  const rects = input instanceof Map ? [...input.values()] : Array.isArray(input) ? input : Object.values(input);
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + (rect.w ?? rect.width)));
  const bottom = Math.max(...rects.map((rect) => rect.y + (rect.h ?? rect.height)));
  return { x: left, y: top, width: right - left, height: bottom - top, left, top, right, bottom };
}

export const layoutColumnTree = layoutColumns;
export const layoutIndentedRail = layoutRail;
