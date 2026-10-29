import { normalizeBrainCategoryLabel } from "./types";

export const CENTER_HUB_ID = "__memory-center";
export const TYPE_HUB_ID_PREFIX = "__type-hub:";

const TYPE_COLORS_DARK = [
  "#e11d48",
  "#7c3aed",
  "#2563eb",
  "#0d9488",
  "#16a34a",
  "#ca8a04",
  "#ea580c",
  "#64748b",
  "#db2777",
  "#4f46e5",
  "#0891b2",
  "#65a30d",
];

const TYPE_COLORS_LIGHT = [
  "#be123c",
  "#6d28d9",
  "#1d4ed8",
  "#0f766e",
  "#15803d",
  "#a16207",
  "#c2410c",
  "#475569",
  "#be185d",
  "#4338ca",
  "#0e7490",
  "#4d7c0f",
];

export type MemoryClusterNode = {
  id: string;
  category?: string | null;
  confidence?: number | null;
};

export type TypeClusterHub2d = {
  id: string;
  key: string;
  label: string;
  count: number;
  x: number;
  y: number;
};

export type TypeClusterHub3d = TypeClusterHub2d & { z: number };

type GroupedMemories = {
  key: string;
  label: string;
  members: MemoryClusterNode[];
};

export function memoryGroupKey(memory: {
  category?: string | null;
}): string {
  return normalizeBrainCategoryLabel(memory.category);
}

export function typeHubId(key: string): string {
  return `${TYPE_HUB_ID_PREFIX}${key}`;
}

export function isGraphHubId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id === CENTER_HUB_ID || id.startsWith(TYPE_HUB_ID_PREFIX);
}

function hashToIndex(value: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % modulo;
}

export function colorForMemoryGroup(
  key: string,
  theme: "light" | "dark" = "dark",
): string {
  const palette = theme === "light" ? TYPE_COLORS_LIGHT : TYPE_COLORS_DARK;
  return palette[hashToIndex(memoryGroupKey({ category: key }), palette.length)];
}

export function memoriesShareGroup(
  left: { category?: string | null },
  right: { category?: string | null },
): boolean {
  return memoryGroupKey(left) === memoryGroupKey(right);
}

function groupNodes(nodes: MemoryClusterNode[]) {
  const groups = new Map<string, MemoryClusterNode[]>();
  for (const node of nodes) {
    const key = memoryGroupKey(node);
    const bucket = groups.get(key);
    if (bucket) bucket.push(node);
    else groups.set(key, [node]);
  }

  return [...groups.entries()]
    .map(([key, members]) => ({
      key,
      label: key,
      members: [...members].sort(
        (a, b) =>
          (b.confidence ?? 0) - (a.confidence ?? 0) || a.id.localeCompare(b.id),
      ),
    }))
    .sort(
      (a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key),
    );
}

/** Alternate large and small groups so the biggest clusters are not neighbors. */
export function interleaveBySize<T>(items: T[]): T[] {
  if (items.length <= 2) return [...items];
  const result: T[] = [];
  let head = 0;
  let tail = items.length - 1;
  while (head <= tail) {
    result.push(items[head]);
    head += 1;
    if (head <= tail) {
      result.push(items[tail]);
      tail -= 1;
    }
  }
  return result;
}

function angularGap(a: number, b: number): number {
  const delta = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(delta, Math.PI * 2 - delta);
}

function packOrbit(
  slices: Array<{ angle: number; radius: number }>,
  padding: number,
  minOrbit: number,
): number {
  if (slices.length <= 1) return minOrbit;
  let orbit = minOrbit;
  for (let i = 0; i < slices.length; i += 1) {
    const next = slices[(i + 1) % slices.length];
    const gap = Math.max(angularGap(slices[i].angle, next.angle), 0.08);
    const needed =
      (slices[i].radius + next.radius + padding) / (2 * Math.sin(gap / 2));
    if (Number.isFinite(needed)) orbit = Math.max(orbit, needed);
  }
  return orbit;
}

function diskRadius2d(count: number, spacing: number): number {
  if (count <= 1) return spacing * 0.62;
  return spacing * (0.78 + Math.sqrt(count / Math.PI));
}

function placeAroundHub2d(
  members: MemoryClusterNode[],
  hub: { x: number; y: number },
  spacing: number,
  outward: number,
  positions: Record<string, { x: number; y: number }>,
) {
  if (members.length === 1) {
    positions[members[0].id] = {
      x: hub.x + Math.cos(outward) * spacing * 0.72,
      y: hub.y + Math.sin(outward) * spacing * 0.72,
    };
    return;
  }

  let index = 0;
  let ring = 0;
  while (index < members.length) {
    const radius = spacing * (0.82 + ring * 0.98);
    const capacity = Math.min(
      members.length - index,
      Math.max(6, Math.floor((Math.PI * 2 * radius) / spacing)),
    );
    const slice = members.slice(index, index + capacity);
    slice.forEach((node, memberIndex) => {
      const angle = outward + (Math.PI * 2 * memberIndex) / slice.length;
      positions[node.id] = {
        x: hub.x + Math.cos(angle) * radius,
        y: hub.y + Math.sin(angle) * radius,
      };
    });
    index += capacity;
    ring += 1;
  }
}

function clusterRadius3d(count: number): number {
  if (count <= 1) return 6.5;
  return 4.8 * Math.cbrt(count) + 2.8 * Math.sqrt(count);
}

function fibonacciDirection(index: number, count: number) {
  if (count <= 1) return { x: 0, y: 1, z: 0 };
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (index / (count - 1)) * 2;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = goldenAngle * index;
  return {
    x: Math.cos(theta) * ring,
    y,
    z: Math.sin(theta) * ring,
  };
}

function dot3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function scale3(
  dir: { x: number; y: number; z: number },
  scale: number,
) {
  return { x: dir.x * scale, y: dir.y * scale, z: dir.z * scale };
}

function packHubSphereScale(
  dirs: Array<{ x: number; y: number; z: number }>,
  radii: number[],
  padding: number,
): number {
  if (dirs.length <= 1) return 28;
  let scale = 56;
  for (let iter = 0; iter < 18; iter += 1) {
    let overlap = 0;
    for (let i = 0; i < dirs.length; i += 1) {
      for (let j = i + 1; j < dirs.length; j += 1) {
        const ci = scale + radii[i] * 0.62;
        const cj = scale + radii[j] * 0.62;
        const dist = Math.sqrt(
          Math.max(
            0,
            ci * ci + cj * cj - 2 * ci * cj * dot3(dirs[i], dirs[j]),
          ),
        );
        const need = radii[i] + radii[j] + padding;
        if (dist < need) {
          overlap = Math.max(overlap, need / Math.max(dist, 0.08));
        }
      }
    }
    if (overlap <= 1) break;
    scale *= Math.min(1.28, overlap);
  }
  return scale;
}

function placeAroundHub3d(
  members: MemoryClusterNode[],
  hub: { x: number; y: number; z: number },
  radius: number,
  positions: Record<string, { x: number; y: number; z: number }>,
) {
  const hubLength = Math.hypot(hub.x, hub.y, hub.z) || 1;
  const outward = {
    x: hub.x / hubLength,
    y: hub.y / hubLength,
    z: hub.z / hubLength,
  };
  const center = {
    x: hub.x + outward.x * radius * 0.62,
    y: hub.y + outward.y * radius * 0.62,
    z: hub.z + outward.z * radius * 0.62,
  };

  if (members.length === 1) {
    positions[members[0].id] = {
      x: center.x + outward.x * radius * 0.35,
      y: center.y + outward.y * radius * 0.35,
      z: center.z + outward.z * radius * 0.35,
    };
    return;
  }

  members.forEach((node, memberIndex) => {
    const dir = fibonacciDirection(memberIndex, members.length);
    positions[node.id] = {
      x: center.x + dir.x * radius,
      y: center.y + dir.y * radius,
      z: center.z + dir.z * radius,
    };
  });
}

function sliceLayout(groups: GroupedMemories[]) {
  const ordered = interleaveBySize(groups);
  const weights = ordered.map((group) => Math.sqrt(group.members.length) + 0.9);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let cursor = -Math.PI / 2;
  return ordered.map((group, index) => {
    const share = (Math.PI * 2 * weights[index]) / totalWeight;
    const angle = cursor + share / 2;
    cursor += share;
    return { group, angle, share };
  });
}

export function typeClusterLayout2d(
  nodes: MemoryClusterNode[],
  spacing = 300,
): {
  positions: Record<string, { x: number; y: number }>;
  hubs: TypeClusterHub2d[];
  center: { x: number; y: number; count: number };
} {
  const positions: Record<string, { x: number; y: number }> = {};
  const groups = groupNodes(nodes);
  if (nodes.length === 0) {
    return { positions, hubs: [], center: { x: 0, y: 0, count: 0 } };
  }

  const slices = sliceLayout(groups);
  const packed = slices.map((slice) => ({
    angle: slice.angle,
    radius: diskRadius2d(slice.group.members.length, spacing),
  }));
  const maxDisk = Math.max(...packed.map((slice) => slice.radius), spacing);
  const orbit =
    groups.length <= 1
      ? 0
      : packOrbit(packed, spacing * 1.15, maxDisk + spacing * 1.8);

  const hubs: TypeClusterHub2d[] = slices.map((slice) => ({
    id: typeHubId(slice.group.key),
    key: slice.group.key,
    label: slice.group.label,
    count: slice.group.members.length,
    x: Math.cos(slice.angle) * orbit,
    y: Math.sin(slice.angle) * orbit,
  }));

  slices.forEach((slice, index) => {
    const hub = hubs[index];
    placeAroundHub2d(
      slice.group.members,
      hub,
      spacing,
      slice.angle,
      positions,
    );
  });

  return {
    positions,
    hubs,
    center: { x: 0, y: 0, count: nodes.length },
  };
}

export function typeClusterLayout3d(
  nodes: MemoryClusterNode[],
): {
  positions: Record<string, { x: number; y: number; z: number }>;
  hubs: TypeClusterHub3d[];
  center: { x: number; y: number; z: number; count: number };
} {
  const groups = interleaveBySize(groupNodes(nodes));
  const positions: Record<string, { x: number; y: number; z: number }> = {};
  if (nodes.length === 0) {
    return {
      positions,
      hubs: [],
      center: { x: 0, y: 0, z: 0, count: 0 },
    };
  }

  const dirs = groups.map((_, index) =>
    fibonacciDirection(index, groups.length),
  );
  const radii = groups.map((group) => clusterRadius3d(group.members.length));
  const scale =
    groups.length <= 1 ? 0 : packHubSphereScale(dirs, radii, 22);

  const hubs: TypeClusterHub3d[] = groups.map((group, index) => {
    const point = scale3(dirs[index], scale);
    return {
      id: typeHubId(group.key),
      key: group.key,
      label: group.label,
      count: group.members.length,
      x: point.x,
      y: point.y,
      z: point.z,
    };
  });

  groups.forEach((group, index) => {
    placeAroundHub3d(group.members, hubs[index], radii[index], positions);
  });

  return {
    positions,
    hubs,
    center: { x: 0, y: 0, z: 0, count: nodes.length },
  };
}

export function hexToRgba(color: string, alpha: number): string {
  const normalized = color.trim();
  const match = normalized.match(/^#([0-9a-f]{6})$/i);
  if (!match) return normalized;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}
