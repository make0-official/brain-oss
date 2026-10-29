import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";
import {
  getBrainLinkColors,
  getBrainLinkState,
  getBrainLinkWeightRange,
  linkStrokeOpacity,
  linkWidth3d,
  normalizeLinkWeight,
} from "../lib/graph/memory-link-strength";
import {
  getBrainGraphBackground,
  getBrainGraphUiTheme,
} from "../lib/graph/brain-graph-theme";
import {
  graphNodeResolution,
  graphZoomToFitMs,
  isLargeGraph,
} from "../lib/graph/brain-graph-performance";
import {
  type BrainMemory,
  type BrainMemoryEdge,
  type MemoryGraph3DHandle,
  cappedPixelRatio,
  memoryDisplayText,
} from "../lib/graph/types";
import { displayLinkIds } from "../lib/graph/brain-graph-display-links";
import {
  CENTER_HUB_ID,
  colorForMemoryGroup,
  hexToRgba,
  isGraphHubId,
  memoriesShareGroup,
  memoryGroupKey,
  typeClusterLayout3d,
} from "../lib/graph/brain-graph-type-clusters";

function useReducedMotion() {
  const [reduce, setReduce] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

type SphereNode = BrainMemory & {
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  degree?: number;
  isTypeHub?: boolean;
  isCenterHub?: boolean;
};

type SphereLink = {
  id: string;
  source: string | SphereNode;
  target: string | SphereNode;
  weight: number;
  relationshipType: string;
  sameType?: boolean;
  groupKey?: string;
  linkKind?: "memory" | "type" | "category";
};

const CAMERA_FIT_PADDING = 0.88;
const CAMERA_FIT_MIN_RADIUS = 22;
const HOMEPAGE_AUTO_ROTATE_SPEED = 0.55;
const MODAL_AUTO_ROTATE_SPEED = 0.32;

function truncateText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function cssColorWithAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const rgb = color.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/,
  );
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  return color;
}

function linkEndpointId(
  endpoint: string | SphereNode | null | undefined,
): string {
  if (endpoint == null) return "";
  return typeof endpoint === "object" ? endpoint.id : endpoint;
}

function linkHasEndpoints(link: SphereLink): boolean {
  const source = link.source;
  const target = link.target;
  if (source == null || target == null) return false;
  if (typeof source === "object" && !Number.isFinite(source.x)) return false;
  if (typeof target === "object" && !Number.isFinite(target.x)) return false;
  return true;
}

function fibonacciSphereLayout(
  nodes: BrainMemory[],
  radius: number,
): Record<string, { x: number; y: number; z: number }> {
  const result: Record<string, { x: number; y: number; z: number }> = {};
  const count = nodes.length;
  if (count === 0) return result;
  if (count === 1) {
    result[nodes[0].id] = { x: 0, y: 0, z: 0 };
    return result;
  }

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((node, index) => {
    const y = 1 - (index / (count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * index;
    result[node.id] = {
      x: Math.cos(theta) * ring * radius,
      y: y * radius,
      z: Math.sin(theta) * ring * radius,
    };
  });
  return result;
}

function fitCameraToCluster(
  graph: ForceGraphMethods<SphereNode, SphereLink> | undefined,
  nodes: SphereNode[],
  transitionMs: number,
) {
  if (!graph) return;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let counted = 0;

  for (const node of nodes) {
    const { x, y, z } = node;
    if (
      typeof x !== "number" ||
      !Number.isFinite(x) ||
      typeof y !== "number" ||
      !Number.isFinite(y) ||
      typeof z !== "number" ||
      !Number.isFinite(z)
    ) {
      continue;
    }
    counted += 1;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  if (counted === 0) return;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const radius = Math.max(
    CAMERA_FIT_MIN_RADIUS,
    Math.hypot(maxX - cx, maxY - cy, maxZ - cz) + 8,
  );

  const camera = graph.camera() as {
    fov?: number;
    aspect?: number;
  };
  const fov = ((camera.fov ?? 50) * Math.PI) / 180;
  const aspect = camera.aspect && camera.aspect > 0 ? camera.aspect : 1;
  const vertical = radius / Math.tan(fov / 2);
  const horizontal = radius / (Math.tan(fov / 2) * aspect);
  const distance = Math.max(vertical, horizontal) * CAMERA_FIT_PADDING;

  graph.cameraPosition(
    {
      x: cx + distance * 0.58,
      y: cy + distance * 0.46,
      z: cz + distance * 0.68,
    },
    { x: cx, y: cy, z: cz },
    transitionMs,
  );
}

function createLayoutHubNode(
  id: string,
  label: string,
  category: string,
  position: { x: number; y: number; z: number },
  extras: { isTypeHub?: boolean; isCenterHub?: boolean; degree?: number },
): SphereNode {
  return {
    id,
    content: label,
    category,
    kind: "work",
    entityType: "topic",
    confidence: 100,
    x: position.x,
    y: position.y,
    z: position.z,
    fx: position.x,
    fy: position.y,
    fz: position.z,
    degree: extras.degree ?? 8,
    isTypeHub: extras.isTypeHub,
    isCenterHub: extras.isCenterHub,
  };
}

function nodeSphereRadius(val: number, relSize: number) {
  return Math.cbrt(val) * relSize;
}

function shortMemoryLabel(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "Memory";
  const words = normalized.split(" ");
  const clipped = words.slice(0, 4).join(" ");
  return clipped.length > 22 ? truncateText(clipped, 20) : clipped;
}

function wrapLabelLines(
  text: string,
  maxCharsPerLine = 30,
  maxLines = 3,
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return ["Memory"];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharsPerLine && current) {
      lines.push(current);
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = truncateText(
          lines[maxLines - 1],
          maxCharsPerLine,
        );
        return lines;
      }
      current = word;
    } else {
      current = next;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : ["Memory"];
}

function createLabelSprite(
  lines: string[],
  yOffset: number,
  colors: { stroke: string; fill: string },
  compact = false,
) {
  const fontSize = compact ? 14 : 28;
  const lineHeight = fontSize + (compact ? 3 : 6);
  const paddingX = compact ? 8 : 16;
  const paddingY = compact ? 4 : 12;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Sprite();

  ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
  const maxLineWidth = Math.max(
    ...lines.map((line) => ctx.measureText(line).width),
    1,
  );
  canvas.width = Math.ceil(maxLineWidth + paddingX * 2);
  canvas.height = lines.length * lineHeight + paddingY * 2;

  ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = compact ? 2.5 : 5;

  lines.forEach((line, index) => {
    const y = paddingY + lineHeight * index + lineHeight / 2;
    ctx.strokeStyle = colors.stroke;
    ctx.strokeText(line, canvas.width / 2, y);
    ctx.fillStyle = colors.fill;
    ctx.fillText(line, canvas.width / 2, y);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  const aspect = canvas.width / canvas.height;
  const labelHeight = compact
    ? Math.max(2.8, lines.length * 1.55)
    : Math.max(12, lines.length * 5.5);
  sprite.scale.set(labelHeight * aspect, labelHeight, 1);
  sprite.center.set(0.5, 0);
  sprite.position.set(0, yOffset, 0);
  sprite.renderOrder = 999;
  return sprite;
}

const NODE_REL_SIZE = 1.15;
const TYPE_HUB_RING_GEOMETRY = new THREE.TorusGeometry(2.05, 0.16, 12, 36);
const CENTER_HUB_RING_GEOMETRY = new THREE.TorusGeometry(1.55, 0.12, 10, 28);

function computeNodeVal(degree: number, maxDegree: number) {
  const t = Math.sqrt(degree / Math.max(maxDegree, 1));
  return 0.72 + t * 1.15;
}

function computeDegrees(
  nodeIds: string[],
  edges: BrainMemoryEdge[],
): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const id of nodeIds) degrees.set(id, 0);
  for (const edge of edges) {
    degrees.set(edge.fromMemoryId, (degrees.get(edge.fromMemoryId) ?? 0) + 1);
    degrees.set(edge.toMemoryId, (degrees.get(edge.toMemoryId) ?? 0) + 1);
  }
  return degrees;
}

export const MemoryGraphSphere3D = forwardRef<
  MemoryGraph3DHandle,
  {
    nodes: BrainMemory[];
    edges: BrainMemoryEdge[];
    onSelect: (memory: BrainMemory | null) => void;
    selectedNodeId?: string | null;
    highlightedNodeId?: string | null;
    onNodeHover?: (
      memory: BrainMemory | null,
      position?: { x: number; y: number },
    ) => void;
    onVisibleNodeIds?: (ids: string[]) => void;
    onPositionChange?: (
      id: string,
      position: { x: number; y: number; z: number },
    ) => void;
    visibleNodeIds?: Set<string>;
    visibleEdgeIds?: Set<string>;
    accentByNodeId?: Record<string, string>;
    originPhotoURL?: string | null;
    theme?: "light" | "dark";
    transparentBackground?: boolean;
    retrieveFlowActive?: boolean;
    /** Marketing embed: auto-rotate, no node drag, no wheel capture. */
    homepageEmbed?: boolean;
    /** Pause the WebGL loop (offscreen / another canvas is active). */
    pauseAnimation?: boolean;
    /** User toggle: stop idle camera auto-rotate. */
    pauseRotation?: boolean;
    onCategoryFocus?: (categoryKey: string | null) => void;
  }
>(function MemoryGraphSphere3D(
  {
    nodes,
    edges,
    onSelect,
    selectedNodeId,
    highlightedNodeId,
    onNodeHover,
    onVisibleNodeIds,
    onPositionChange,
    visibleNodeIds,
    visibleEdgeIds,
    accentByNodeId,
    theme = "dark",
    transparentBackground = false,
    retrieveFlowActive = false,
    homepageEmbed = false,
    pauseAnimation = false,
    pauseRotation = false,
    onCategoryFocus,
  },
  ref,
) {
  const shouldReduceMotion = useReducedMotion();
  const reduceMotion = Boolean(shouldReduceMotion);
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<SphereNode, SphereLink> | undefined>(undefined);
  const labelSpriteCacheRef = useRef(new Map<string, object>());
  const hoveredNodeIdRef = useRef<string | null>(null);
  const onNodeHoverRef = useRef(onNodeHover);
  const onCategoryFocusRef = useRef(onCategoryFocus);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [mounted, setMounted] = useState(false);
  const fitKeyRef = useRef<string | null>(null);
  const traversalCameraDistanceRef = useRef<number | null>(null);
  const idleRotatePausedRef = useRef(false);

  onNodeHoverRef.current = onNodeHover;
  onCategoryFocusRef.current = onCategoryFocus;

  const isDark = theme === "dark";
  const uiTheme = useMemo(
    () => getBrainGraphUiTheme(isDark ? "dark" : "light"),
    [isDark],
  );
  const graphBackground = useMemo(
    () =>
      transparentBackground
        ? "rgba(0,0,0,0)"
        : getBrainGraphBackground(isDark ? "dark" : "light"),
    [isDark, transparentBackground],
  );

  const layoutKey = useMemo(
    () =>
      [
        theme,
        "type-spread-v3",
        nodes
          .map((node) => `${node.id}:${memoryGroupKey(node)}`)
          .sort()
          .join(","),
        edges
          .map((edge) => edge.id)
          .sort()
          .join(","),
      ].join("|"),
    [edges, nodes, theme],
  );

  const nodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const largeGraph = isLargeGraph(nodes.length);
  const zoomToFitMs = graphZoomToFitMs(nodes.length);
  const displayEdgeIds = useMemo(
    () =>
      homepageEmbed
        ? new Set(edges.map((edge) => edge.id))
        : displayLinkIds(nodeIds, edges),
    [edges, homepageEmbed, nodeIds],
  );

  const degrees = useMemo(
    () => computeDegrees(nodeIds, edges),
    [edges, nodeIds],
  );

  const maxDegree = useMemo(() => {
    let max = 1;
    for (const degree of degrees.values()) max = Math.max(max, degree);
    return max;
  }, [degrees]);

  const neighborIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const neighbors = new Set<string>([selectedNodeId]);
    for (const edge of edges) {
      if (edge.fromMemoryId === selectedNodeId) neighbors.add(edge.toMemoryId);
      if (edge.toMemoryId === selectedNodeId) neighbors.add(edge.fromMemoryId);
    }
    return neighbors;
  }, [edges, selectedNodeId]);

  const emphasizedNodeIds = useMemo(() => {
    const ids = new Set(neighborIds);
    if (highlightedNodeId) ids.add(highlightedNodeId);
    return ids;
  }, [highlightedNodeId, neighborIds]);

  const typeLayout = useMemo(() => typeClusterLayout3d(nodes), [layoutKey]);

  const compactLayout = useMemo(() => {
    if (homepageEmbed) {
      return fibonacciSphereLayout(
        nodes,
        28 + Math.sqrt(Math.max(nodes.length, 1)) * 2.6,
      );
    }
    return typeLayout.positions;
  }, [homepageEmbed, layoutKey, nodes, typeLayout.positions]);

  const graphNodesRef = useRef<SphereNode[]>([]);
  const placedNodeIdsRef = useRef<string[]>([]);
  const placedEdgeIdsRef = useRef<string[]>([]);
  const skipRelayoutRef = useRef(false);

  const graphData = useMemo(() => {
    const previousById = new Map(
      graphNodesRef.current.map((node) => [node.id, node]),
    );
    const previousIds = placedNodeIdsRef.current;
    const previousIdSet = new Set(previousIds);
    const previousEdgeIds = placedEdgeIdsRef.current;
    const previousEdgeIdSet = new Set(previousEdgeIds);
    const sameNodes =
      previousIds.length > 0 &&
      nodes.length === previousIds.length &&
      nodes.every((node) => previousIdSet.has(node.id));
    const removedNodesOnly =
      previousIds.length > 0 &&
      nodes.length < previousIds.length &&
      nodes.every((node) => previousIdSet.has(node.id));
    const removedLinksOnly =
      sameNodes &&
      previousEdgeIds.length > 0 &&
      edges.length < previousEdgeIds.length &&
      edges.every((edge) => previousEdgeIdSet.has(edge.id));
    const preserveLayout = removedNodesOnly || removedLinksOnly;
    if (preserveLayout) skipRelayoutRef.current = true;

    const sphereNodes: SphereNode[] = nodes.map((node) => {
      const previous = previousById.get(node.id);
      const layout = compactLayout[node.id];
      const x = preserveLayout
        ? (previous?.fx ?? previous?.x ?? layout?.x ?? 0)
        : (layout?.x ?? previous?.x ?? 0);
      const y = preserveLayout
        ? (previous?.fy ?? previous?.y ?? layout?.y ?? 0)
        : (layout?.y ?? previous?.y ?? 0);
      const z = preserveLayout
        ? (previous?.fz ?? previous?.z ?? layout?.z ?? 0)
        : (layout?.z ?? previous?.z ?? 0);

      return {
        ...node,
        x,
        y,
        z,
        fx: x,
        fy: y,
        fz: z,
        degree: degrees.get(node.id) ?? 0,
      };
    });

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const links: SphereLink[] = edges
      .filter((edge) => displayEdgeIds.has(edge.id))
      .map((edge) => {
        const from = nodeById.get(edge.fromMemoryId);
        const to = nodeById.get(edge.toMemoryId);
        const sameType = memoriesShareGroup(
          from ?? { category: "" },
          to ?? { category: "" },
        );
        return {
          id: edge.id,
          source: edge.fromMemoryId,
          target: edge.toMemoryId,
          weight: edge.weight,
          relationshipType: edge.relationshipType,
          sameType,
          groupKey: sameType
            ? memoryGroupKey(from ?? { category: "" })
            : undefined,
          linkKind: "memory" as const,
        };
      });

    if (!homepageEmbed && typeLayout.hubs.length > 0) {
      if (typeLayout.hubs.length > 1) {
        sphereNodes.push(
          createLayoutHubNode(
            CENTER_HUB_ID,
            `${typeLayout.center.count} memories`,
            "General",
            typeLayout.center,
            {
              isCenterHub: true,
              degree: Math.max(maxDegree, typeLayout.hubs.length),
            },
          ),
        );
      }
      for (const hub of typeLayout.hubs) {
        sphereNodes.push(
          createLayoutHubNode(
            hub.id,
            `${hub.label} · ${hub.count}`,
            hub.key,
            { x: hub.x, y: hub.y, z: hub.z },
            {
              isTypeHub: true,
              degree: Math.max(hub.count, 4),
            },
          ),
        );
        if (typeLayout.hubs.length > 1) {
          links.push({
            id: `__category:${hub.id}`,
            source: CENTER_HUB_ID,
            target: hub.id,
            weight: 1,
            relationshipType: "category",
            sameType: false,
            linkKind: "category",
          });
        }
        if (hub.count <= 12) {
          for (const node of nodes) {
            if (memoryGroupKey(node) !== hub.key) continue;
            links.push({
              id: `__type:${hub.id}:${node.id}`,
              source: hub.id,
              target: node.id,
              weight: 0.82,
              relationshipType: "type",
              sameType: true,
              groupKey: hub.key,
              linkKind: "type",
            });
          }
        }
      }
    }

    graphNodesRef.current = sphereNodes;
    placedNodeIdsRef.current = nodes.map((node) => node.id);
    placedEdgeIdsRef.current = edges.map((edge) => edge.id);

    const nodeIdSet = new Set(sphereNodes.map((node) => node.id));
    const resolvedLinks = links.filter((link) => {
      const sourceId = linkEndpointId(link.source);
      const targetId = linkEndpointId(link.target);
      return nodeIdSet.has(sourceId) && nodeIdSet.has(targetId);
    });

    return { nodes: sphereNodes, links: resolvedLinks };
  }, [
    compactLayout,
    degrees,
    displayEdgeIds,
    edges,
    homepageEmbed,
    maxDegree,
    nodes,
    typeLayout,
  ]);

  useEffect(() => {
    if (!onVisibleNodeIds) return;
    if (nodes.length <= 64) {
      onVisibleNodeIds(nodes.map((node) => node.id));
      return;
    }
    const ids = [selectedNodeId, highlightedNodeId].filter((id): id is string =>
      Boolean(id),
    );
    if (ids.length > 0) onVisibleNodeIds(ids);
  }, [highlightedNodeId, nodes, onVisibleNodeIds, selectedNodeId]);

  const graphVisibleNodeIds = useMemo(() => {
    if (!visibleNodeIds) return null;
    const next = new Set(visibleNodeIds);
    let anyVisible = false;
    for (const hub of typeLayout.hubs) {
      const show = nodes.some(
        (node) =>
          memoryGroupKey(node) === hub.key && visibleNodeIds.has(node.id),
      );
      if (show) {
        next.add(hub.id);
        anyVisible = true;
      }
    }
    if (anyVisible && typeLayout.hubs.length > 1) next.add(CENTER_HUB_ID);
    return next;
  }, [nodes, typeLayout.hubs, visibleNodeIds]);

  const nodeVisible = useCallback(
    (node: SphereNode) =>
      graphVisibleNodeIds ? graphVisibleNodeIds.has(node.id) : true,
    [graphVisibleNodeIds],
  );

  const linkVisible = useCallback(
    (link: SphereLink) => {
      if (!linkHasEndpoints(link)) return false;
      const decorative =
        link.linkKind === "type" || link.linkKind === "category";
      if (!decorative && visibleEdgeIds && !visibleEdgeIds.has(link.id)) {
        return false;
      }
      if (!graphVisibleNodeIds) return true;
      const sourceId = linkEndpointId(link.source);
      const targetId = linkEndpointId(link.target);
      if (!sourceId || !targetId) return false;
      return (
        graphVisibleNodeIds.has(sourceId) && graphVisibleNodeIds.has(targetId)
      );
    },
    [graphVisibleNodeIds, visibleEdgeIds],
  );

  const isFocusNode = useCallback(
    (nodeId: string) => {
      if (!selectedNodeId) return true;
      return emphasizedNodeIds.has(nodeId);
    },
    [emphasizedNodeIds, selectedNodeId],
  );

  const shouldShowNodeLabel = useCallback(
    (node: SphereNode) =>
      homepageEmbed || Boolean(node.isTypeHub || node.isCenterHub),
    [homepageEmbed],
  );

  const getLabelSprite = useCallback(
    (node: SphereNode) => {
      const cacheKey = homepageEmbed
        ? `${node.id}:compact`
        : `${node.id}:${memoryDisplayText(node)}`;
      const cached = labelSpriteCacheRef.current.get(cacheKey);
      if (cached) return cached;

      const degree = node.degree ?? 0;
      const val = computeNodeVal(degree, maxDegree);
      const radius =
        node.isTypeHub || node.isCenterHub
          ? 3.4
          : nodeSphereRadius(val, NODE_REL_SIZE);
      const description =
        node.isTypeHub || node.isCenterHub
          ? node.content
          : homepageEmbed
            ? shortMemoryLabel(memoryDisplayText(node))
            : truncateText(memoryDisplayText(node), 96);
      const lines = wrapLabelLines(
        description,
        homepageEmbed || node.isTypeHub || node.isCenterHub ? 18 : 30,
        homepageEmbed || node.isTypeHub || node.isCenterHub ? 1 : 3,
      );
      const sprite = createLabelSprite(
        lines,
        radius + (homepageEmbed ? 6 : 12),
        {
          stroke: uiTheme.labelSpriteStroke,
          fill: uiTheme.labelSpriteFill,
        },
        homepageEmbed,
      );
      labelSpriteCacheRef.current.set(cacheKey, sprite);
      return sprite;
    },
    [
      homepageEmbed,
      maxDegree,
      uiTheme.labelSpriteFill,
      uiTheme.labelSpriteStroke,
    ],
  );

  const getNodeThreeObject = useCallback(
    (node: SphereNode) => {
      if (node.isTypeHub || node.isCenterHub) {
        const group = new THREE.Group();
        const color = node.isCenterHub
          ? isDark
            ? "#94a3b8"
            : "#475569"
          : colorForMemoryGroup(
              memoryGroupKey(node),
              isDark ? "dark" : "light",
            );
        const ring = new THREE.Mesh(
          node.isCenterHub ? CENTER_HUB_RING_GEOMETRY : TYPE_HUB_RING_GEOMETRY,
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: node.isCenterHub ? 0.55 : 0.82,
            depthWrite: false,
          }),
        );
        ring.rotation.x = Math.PI / 2;
        group.add(ring);
        group.add(getLabelSprite(node) as THREE.Object3D);
        return group;
      }
      if (!shouldShowNodeLabel(node)) return undefined;
      return getLabelSprite(node);
    },
    [getLabelSprite, isDark, shouldShowNodeLabel],
  );

  const zoomCamera = useCallback((factor: number) => {
    const graph = fgRef.current;
    if (!graph) return;
    const camera = graph.camera() as {
      position: { x: number; y: number; z: number };
    };
    const { x, y, z } = camera.position;
    graph.cameraPosition(
      { x: x * factor, y: y * factor, z: z * factor },
      undefined,
      220,
    );
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      resetView: () => {
        traversalCameraDistanceRef.current = null;
        fitCameraToCluster(fgRef.current, graphData.nodes, zoomToFitMs);
      },
      zoomIn: () => zoomCamera(0.82),
      zoomOut: () => zoomCamera(1.22),
      focusOnNode: (nodeId: string) => {
        const node = graphData.nodes.find((entry) => entry.id === nodeId);
        if (!node || node.x == null || node.y == null) return;

        const z = node.z ?? 0;
        const degree = node.degree ?? 0;
        const val = computeNodeVal(degree, maxDegree);
        const radius = nodeSphereRadius(val, NODE_REL_SIZE);
        const labelLines = wrapLabelLines(
          truncateText(memoryDisplayText(node), 96),
        );
        const labelHeight = Math.max(12, labelLines.length * 5.5);
        const labelCenterY = radius + 12 + labelHeight * 0.5;
        const lookAt = { x: node.x, y: node.y + labelCenterY, z };
        const computedDistance = Math.min(165, Math.max(100, 92 + radius * 4));
        const distance = traversalCameraDistanceRef.current ?? computedDistance;
        traversalCameraDistanceRef.current = distance;

        fgRef.current?.cameraPosition(
          { x: node.x, y: node.y + labelCenterY * 0.25, z: z + distance },
          lookAt,
          480,
        );
      },
    }),
    [graphData.nodes, maxDegree, zoomCamera, zoomToFitMs],
  );

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    labelSpriteCacheRef.current.clear();
  }, [layoutKey]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !mounted) return;

    if (homepageEmbed) {
      const blockZoom = (event: WheelEvent) => {
        event.stopPropagation();
      };
      element.addEventListener("wheel", blockZoom, { capture: true });
      return () => {
        element.removeEventListener("wheel", blockZoom, { capture: true });
      };
    }

    const onWheel = (event: WheelEvent) => {
      const graph = fgRef.current;
      if (!graph) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const camera = graph.camera() as {
        position: {
          clone: () => {
            sub: (value: unknown) => {
              length: () => number;
              multiplyScalar: (value: number) => unknown;
            };
          };
          copy: (value: unknown) => { add: (value: unknown) => unknown };
          distanceTo: (value: unknown) => number;
          add: (value: unknown) => unknown;
        };
        fov?: number;
        updateMatrixWorld: () => void;
        matrixWorld: THREE.Matrix4;
      };
      const controls = graph.controls() as {
        target?: { add: (value: unknown) => unknown };
        update?: () => void;
      } | null;
      const target = controls?.target;
      if (!camera?.position || !target) return;

      if (event.ctrlKey || event.metaKey) {
        const step = Math.max(-0.1, Math.min(0.1, event.deltaY * 0.0032));
        const factor = Math.exp(step);
        const offset = camera.position.clone().sub(target);
        const nextLength = offset.length() * factor;
        if (nextLength < 6 || nextLength > 1200) return;
        offset.multiplyScalar(factor);
        camera.position.copy(target).add(offset);
        controls?.update?.();
        return;
      }

      const rect = element.getBoundingClientRect();
      const distance = camera.position.distanceTo(target);
      const fovDeg =
        "fov" in camera && typeof camera.fov === "number" ? camera.fov : 50;
      const viewHeight = 2 * Math.tan((fovDeg * Math.PI) / 360) * distance;
      const viewWidth = viewHeight * (rect.width / Math.max(rect.height, 1));
      const panX = (event.deltaX / Math.max(rect.width, 1)) * viewWidth;
      const panY = (event.deltaY / Math.max(rect.height, 1)) * viewHeight;

      camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(
        camera.matrixWorld,
        0,
      );
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      // Match 2D: pan.x -= deltaX, pan.y -= deltaY (content follows the fingers).
      const shift = right.multiplyScalar(panX).add(up.multiplyScalar(-panY));
      camera.position.add(shift);
      target.add(shift);
      controls?.update?.();
    };

    element.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      element.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [mounted, homepageEmbed]);

  const forcesConfiguredRef = useRef(false);

  useEffect(() => {
    if (skipRelayoutRef.current) {
      skipRelayoutRef.current = false;
      fitKeyRef.current = layoutKey;
      return;
    }

    forcesConfiguredRef.current = false;
    fitKeyRef.current = null;
    traversalCameraDistanceRef.current = null;
  }, [layoutKey]);

  useEffect(() => {
    if (!mounted || size.width <= 0 || graphData.nodes.length === 0) return;
    if (fitKeyRef.current === layoutKey) return;

    const immediate = window.setTimeout(() => {
      fitCameraToCluster(fgRef.current, graphData.nodes, 0);
    }, 0);

    return () => {
      window.clearTimeout(immediate);
    };
  }, [graphData.nodes, layoutKey, mounted, size.height, size.width]);

  useEffect(() => {
    return () => {
      try {
        fgRef.current?.pauseAnimation();
      } catch {
        // Graph may already be torn down.
      }
    };
  }, []);

  useEffect(() => {
    const graph = fgRef.current;
    if (!graph || !mounted) return;
    try {
      if (pauseAnimation) graph.pauseAnimation();
      else graph.resumeAnimation();
    } catch {
      // Graph may not be ready yet.
    }
  }, [mounted, pauseAnimation, size.height, size.width]);

  const autoRotateEnabled = !reduceMotion && (homepageEmbed || !pauseRotation);

  const syncAutoRotate = useCallback(
    (enabled: boolean) => {
      const controls = fgRef.current?.controls() as
        | {
            autoRotate?: boolean;
            autoRotateSpeed?: number;
            enableZoom?: boolean;
            enablePan?: boolean;
            zoomSpeed?: number;
            update?: () => void;
          }
        | null
        | undefined;
      if (!controls) return;
      if (homepageEmbed) {
        controls.enableZoom = false;
        controls.enablePan = false;
      } else {
        controls.zoomSpeed = 1.05;
      }
      const shouldRotate =
        enabled && autoRotateEnabled && !idleRotatePausedRef.current;
      controls.autoRotate = shouldRotate;
      controls.autoRotateSpeed = homepageEmbed
        ? HOMEPAGE_AUTO_ROTATE_SPEED
        : MODAL_AUTO_ROTATE_SPEED;
    },
    [autoRotateEnabled, homepageEmbed],
  );

  useEffect(() => {
    if (!mounted) return;
    const graph = fgRef.current;
    if (!graph) return;

    const applyControls = () => {
      if (homepageEmbed) {
        const renderer = graph.renderer() as {
          setPixelRatio?: (value: number) => void;
        };
        renderer?.setPixelRatio?.(cappedPixelRatio());
      }
      syncAutoRotate(true);
    };

    const timer = window.setTimeout(applyControls, 360);
    return () => window.clearTimeout(timer);
  }, [
    autoRotateEnabled,
    homepageEmbed,
    layoutKey,
    mounted,
    size.height,
    size.width,
    syncAutoRotate,
  ]);

  useEffect(() => {
    idleRotatePausedRef.current = Boolean(selectedNodeId);
    syncAutoRotate(!selectedNodeId);
  }, [selectedNodeId, syncAutoRotate]);

  useEffect(() => {
    if (!mounted || !autoRotateEnabled) return;
    const element = containerRef.current;
    if (!element) return;
    let resumeTimer: number | undefined;

    const pauseRotate = () => {
      idleRotatePausedRef.current = true;
      syncAutoRotate(false);
      if (resumeTimer) window.clearTimeout(resumeTimer);
    };
    const resumeRotate = () => {
      resumeTimer = window.setTimeout(() => {
        if (selectedNodeId) return;
        idleRotatePausedRef.current = false;
        syncAutoRotate(true);
      }, 1800);
    };

    element.addEventListener("pointerdown", pauseRotate);
    element.addEventListener("pointerup", resumeRotate);
    element.addEventListener("pointerleave", resumeRotate);
    return () => {
      if (resumeTimer) window.clearTimeout(resumeTimer);
      element.removeEventListener("pointerdown", pauseRotate);
      element.removeEventListener("pointerup", resumeRotate);
      element.removeEventListener("pointerleave", resumeRotate);
    };
  }, [autoRotateEnabled, mounted, selectedNodeId, syncAutoRotate]);

  const configureForces = useCallback(() => {
    const graph = fgRef.current;
    if (!graph || forcesConfiguredRef.current) return;

    graph.d3Force("charge", null);
    graph.d3Force("center", null);
    graph.d3Force("link", null);
    graph.d3Force("collision", null);

    forcesConfiguredRef.current = true;
  }, []);

  const handleEngineTick = useCallback(() => {
    configureForces();
    syncAutoRotate(true);
  }, [configureForces, syncAutoRotate]);

  const handleEngineStop = useCallback(() => {
    if (fitKeyRef.current === layoutKey) return;
    fitKeyRef.current = layoutKey;
    fitCameraToCluster(fgRef.current, graphData.nodes, zoomToFitMs);
  }, [graphData.nodes, layoutKey, zoomToFitMs]);

  const handleNodeHover = useCallback((node: SphereNode | null) => {
    const nextId = node?.id ?? null;
    if (hoveredNodeIdRef.current === nextId) return;
    hoveredNodeIdRef.current = nextId;

    const hoverHandler = onNodeHoverRef.current;
    if (!hoverHandler) return;

    if (!node || isGraphHubId(node.id) || node.isTypeHub || node.isCenterHub) {
      hoverHandler(null);
      return;
    }

    const coords = fgRef.current?.graph2ScreenCoords(
      node.x ?? 0,
      node.y ?? 0,
      node.z ?? 0,
    );
    if (!coords) {
      hoverHandler(node);
      return;
    }
    hoverHandler(node, { x: coords.x, y: coords.y });
  }, []);

  const linkColors = useMemo(
    () => getBrainLinkColors(isDark ? "dark" : "light"),
    [isDark],
  );

  const linkWeightRange = useMemo(() => {
    const scopedEdges =
      selectedNodeId != null
        ? edges.filter(
            (edge) =>
              edge.fromMemoryId === selectedNodeId ||
              edge.toMemoryId === selectedNodeId,
          )
        : edges;
    return getBrainLinkWeightRange(scopedEdges);
  }, [edges, selectedNodeId]);

  const resolveLinkVisuals = useCallback(
    (link: SphereLink) => {
      if (!linkHasEndpoints(link)) {
        return {
          isActive: false,
          dimmed: true,
          strength: 0,
          color: "rgba(0,0,0,0)",
          width: 0,
          opacity: 0,
          particleColor: "rgba(0,0,0,0)",
        };
      }
      const sourceId = linkEndpointId(link.source);
      const targetId = linkEndpointId(link.target);
      const state = getBrainLinkState({
        selectedNodeId: selectedNodeId ?? null,
        highlightedNodeId,
        sourceId,
        targetId,
      });
      const strength = normalizeLinkWeight(link.weight);
      const linkKind = link.linkKind ?? "memory";
      const groupKey =
        link.groupKey ||
        memoryGroupKey({
          category:
            typeof link.source === "object"
              ? link.source.category
              : typeof link.target === "object"
                ? link.target.category
                : "",
        });
      const typeColor = colorForMemoryGroup(
        groupKey,
        isDark ? "dark" : "light",
      );
      let color = state.isActive ? linkColors.active : linkColors.base;
      let width = linkWidth3d(
        strength,
        state.isActive,
        linkWeightRange,
        state.dimmed,
        isDark ? "dark" : "light",
      );
      let opacity = linkStrokeOpacity(strength, {
        isActive: state.isActive,
        dimmed: state.dimmed,
        range: linkWeightRange,
        theme: isDark ? "dark" : "light",
      });
      if (!state.isActive) {
        if (linkKind === "category") {
          color = isDark ? "rgba(100, 116, 139, 1)" : "rgba(71, 85, 105, 1)";
          width = 0.55;
          opacity = isDark ? 0.38 : 0.32;
        } else if (linkKind === "type") {
          color = hexToRgba(typeColor, 1);
          width *= 0.7;
          opacity = isDark ? 0.32 : 0.26;
        } else if (link.sameType) {
          color = hexToRgba(typeColor, 1);
          width *= 0.92;
          opacity = isDark ? 0.4 : 0.34;
        } else {
          width *= 0.5;
          opacity *= 0.12;
        }
      }
      return {
        ...state,
        strength,
        color,
        width,
        opacity,
        particleColor: state.isActive
          ? linkColors.particleActive
          : linkColors.particleBase,
      };
    },
    [highlightedNodeId, isDark, linkColors, linkWeightRange, selectedNodeId],
  );

  const nodeColor = useCallback(
    (node: SphereNode) => {
      if (node.isCenterHub) return isDark ? "#0b0f14" : "#111827";
      if (node.isTypeHub) {
        return colorForMemoryGroup(
          memoryGroupKey(node),
          isDark ? "dark" : "light",
        );
      }
      if (highlightedNodeId === node.id) return "#fbbf24";
      if (selectedNodeId && !isFocusNode(node.id)) {
        return uiTheme.sphereDimmedNode;
      }
      if (accentByNodeId?.[node.id]) return accentByNodeId[node.id];
      return colorForMemoryGroup(
        memoryGroupKey(node),
        isDark ? "dark" : "light",
      );
    },
    [
      accentByNodeId,
      highlightedNodeId,
      isDark,
      isFocusNode,
      selectedNodeId,
      uiTheme.sphereDimmedNode,
    ],
  );

  const nodeVal = useCallback(
    (node: SphereNode) => {
      if (node.isCenterHub) return 4.8;
      if (node.isTypeHub) {
        return 2.4 + Math.min(1.6, Math.log2((node.degree ?? 4) + 1) * 0.45);
      }
      const base = computeNodeVal(node.degree ?? 0, maxDegree);
      if (!selectedNodeId) return base;
      if (node.id === selectedNodeId) return base * 1.35;
      if (isFocusNode(node.id)) return base * 1.12;
      return base * 0.72;
    },
    [isFocusNode, maxDegree, selectedNodeId],
  );

  const linkColor = useCallback(
    (link: SphereLink) => {
      const visuals = resolveLinkVisuals(link);
      if (retrieveFlowActive && !visuals.dimmed && !visuals.isActive) {
        return cssColorWithAlpha(
          isDark ? "rgba(103, 232, 249, 1)" : "rgba(14, 165, 233, 1)",
          Math.min(0.62, visuals.opacity + 0.1),
        );
      }
      return cssColorWithAlpha(visuals.color, visuals.opacity);
    },
    [isDark, resolveLinkVisuals, retrieveFlowActive],
  );

  const linkWidth = useCallback(
    (link: SphereLink) => resolveLinkVisuals(link).width,
    [resolveLinkVisuals],
  );

  const energyFlowEdgeIds = useMemo(() => {
    const flowCount = Math.min(
      56,
      Math.max(12, Math.round(edges.length * 0.22)),
    );
    return new Set(
      [...edges]
        .sort(
          (a, b) =>
            normalizeLinkWeight(b.weight) - normalizeLinkWeight(a.weight),
        )
        .slice(0, flowCount)
        .map((edge) => edge.id),
    );
  }, [edges]);

  const linkParticles = useCallback(
    (link: SphereLink) => {
      if (reduceMotion || !linkVisible(link)) return 0;
      const { isActive, dimmed } = resolveLinkVisuals(link);
      if (dimmed && !retrieveFlowActive) return 0;
      if (retrieveFlowActive) return isActive ? 2 : 1;
      if (selectedNodeId) return isActive ? 2 : 0;
      return energyFlowEdgeIds.has(link.id) ? 1 : 0;
    },
    [
      energyFlowEdgeIds,
      linkVisible,
      reduceMotion,
      resolveLinkVisuals,
      retrieveFlowActive,
      selectedNodeId,
    ],
  );

  const linkParticleColor = useCallback(
    (link: SphereLink) =>
      resolveLinkVisuals(link).isActive
        ? isDark
          ? "#fbbf24"
          : "#c2410c"
        : isDark
          ? "#67e8f9"
          : "#2563eb",
    [isDark, resolveLinkVisuals],
  );

  const particleGeometry = useMemo(
    () =>
      new THREE.SphereGeometry(
        homepageEmbed
          ? isDark
            ? 0.22
            : 0.28
          : retrieveFlowActive
            ? isDark
              ? 0.38
              : 0.52
            : isDark
              ? 0.3
              : 0.42,
        8,
        8,
      ),
    [homepageEmbed, isDark, retrieveFlowActive],
  );

  const linkParticleThreeObject = useCallback(
    (link: SphereLink) =>
      new THREE.Mesh(
        particleGeometry,
        new THREE.MeshBasicMaterial({
          color: linkParticleColor(link),
          transparent: true,
          opacity: retrieveFlowActive ? 0.7 : 0.58,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
    [linkParticleColor, particleGeometry, retrieveFlowActive],
  );

  if (!mounted) {
    return (
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ backgroundColor: graphBackground }}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: graphBackground }}
    >
      {size.width > 0 && size.height > 0 && graphData.nodes.length > 0 ? (
        <ForceGraph3D
          key={theme}
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor={graphBackground}
          showNavInfo={false}
          enableNavigationControls
          controlType="orbit"
          enableNodeDrag={false}
          nodeId="id"
          nodeVal={nodeVal}
          nodeRelSize={NODE_REL_SIZE}
          nodeOpacity={0.94}
          nodeColor={nodeColor}
          nodeVisibility={nodeVisible}
          nodeThreeObject={getNodeThreeObject as never}
          nodeThreeObjectExtend={(node: SphereNode) =>
            !node.isTypeHub && !node.isCenterHub
          }
          onNodeClick={(node) => {
            if (!node) return;
            if (node.isCenterHub) {
              onCategoryFocusRef.current?.(null);
              return;
            }
            if (node.isTypeHub || isGraphHubId(node.id)) {
              onCategoryFocusRef.current?.(memoryGroupKey(node));
              onSelect(null);
              return;
            }
            onSelect(node);
          }}
          onNodeHover={handleNodeHover}
          onBackgroundClick={() => onSelect(null)}
          onEngineTick={handleEngineTick}
          onEngineStop={handleEngineStop}
          linkVisibility={linkVisible}
          linkColor={linkColor}
          linkWidth={linkWidth as never}
          linkOpacity={1}
          linkCurvature={0.08}
          linkDirectionalParticles={linkParticles}
          linkDirectionalParticleWidth={
            homepageEmbed
              ? isDark
                ? 0.4
                : 0.5
              : retrieveFlowActive
                ? isDark
                  ? 0.7
                  : 0.95
                : isDark
                  ? 0.55
                  : 0.78
          }
          linkDirectionalParticleSpeed={
            homepageEmbed ? 0.0015 : retrieveFlowActive ? 0.006 : 0.0036
          }
          linkDirectionalParticleResolution={8}
          linkDirectionalParticleColor={linkParticleColor}
          linkDirectionalParticleThreeObject={linkParticleThreeObject}
          d3AlphaDecay={largeGraph ? 0.05 : 0.026}
          d3VelocityDecay={0.42}
          warmupTicks={0}
          cooldownTicks={0}
          cooldownTime={0}
          nodeResolution={graphNodeResolution(nodes.length)}
        />
      ) : null}
    </div>
  );
});
