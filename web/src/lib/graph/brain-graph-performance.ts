/** Above this count, graph components switch to large-graph optimizations. */
export const LARGE_GRAPH_NODE_THRESHOLD = 150;

/** Unfocused canvas message cards use simplified markdown at this count. */
export const SIMPLIFIED_MESSAGE_RENDER_THRESHOLD = 40;

export function isLargeGraph(nodeCount: number): boolean {
  return nodeCount >= LARGE_GRAPH_NODE_THRESHOLD;
}

export function graphWarmupTicks(nodeCount: number): number {
  if (isLargeGraph(nodeCount)) return 0;
  if (nodeCount >= 40) return 24;
  return 80;
}

export function graphCooldownTicks(nodeCount: number): number {
  if (isLargeGraph(nodeCount)) return 0;
  if (nodeCount >= 40) return 40;
  return 100;
}

/** Camera transition duration for zoomToFit / reset (0 = instant, interactive immediately). */
export function graphZoomToFitMs(nodeCount: number): number {
  if (isLargeGraph(nodeCount)) return 0;
  if (nodeCount >= 40) return 120;
  return 280;
}

export function graphNodeResolution(nodeCount: number): number {
  if (isLargeGraph(nodeCount)) return 6;
  if (nodeCount >= 40) return 8;
  return 12;
}

/** Extra margin in graph coordinates when culling off-screen nodes. */
export const VIEWPORT_CULL_MARGIN = 320;

export function graphViewportBounds(
  width: number,
  height: number,
  pan: { x: number; y: number },
  zoom: number,
  margin = VIEWPORT_CULL_MARGIN,
) {
  const halfW = width / 2;
  const halfH = height / 2;
  return {
    minX: (-halfW - pan.x) / zoom - margin,
    maxX: (halfW - pan.x) / zoom + margin,
    minY: (-halfH - pan.y) / zoom - margin,
    maxY: (halfH - pan.y) / zoom + margin,
  };
}

export function isNodeInViewport(
  node: { x: number; y: number },
  viewport: { minX: number; maxX: number; minY: number; maxY: number },
  nodeRadius = 220,
): boolean {
  return (
    node.x + nodeRadius >= viewport.minX &&
    node.x - nodeRadius <= viewport.maxX &&
    node.y + nodeRadius >= viewport.minY &&
    node.y - nodeRadius <= viewport.maxY
  );
}
