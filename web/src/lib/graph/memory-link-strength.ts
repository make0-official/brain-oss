export function normalizeLinkWeight(weight: number | null | undefined): number {
  if (typeof weight !== "number" || !Number.isFinite(weight)) return 0.5;
  return Math.max(0, Math.min(1, weight));
}

export function formatLinkStrength(weight: number | null | undefined): string {
  return `${Math.round(normalizeLinkWeight(weight) * 100)}%`;
}

export function linkStrengthLabel(weight: number | null | undefined): string {
  const normalized = normalizeLinkWeight(weight);
  if (normalized >= 0.85) return "Strong";
  if (normalized >= 0.65) return "Solid";
  if (normalized >= 0.45) return "Moderate";
  return "Weak";
}

export function mapWeightToVisualStrength(
  weight: number | null | undefined,
  range: { min: number; max: number },
): number {
  const value = normalizeLinkWeight(weight);
  const min = normalizeLinkWeight(range.min);
  const max = normalizeLinkWeight(range.max);

  if (max - min < 0.04) {
    return 0.18 + value * 0.82;
  }

  const t = (value - min) / (max - min);
  return Math.pow(Math.max(0, Math.min(1, t)), 0.5);
}

export function linkStrokeWidth(
  weight: number | null | undefined,
  isActive: boolean,
  range?: { min: number; max: number },
  dimmed = false,
  theme: BrainLinkTheme = "dark",
): number {
  const strength = range
    ? mapWeightToVisualStrength(weight, range)
    : normalizeLinkWeight(weight);
  const lightBoost = theme === "light" ? 0.2 : 0;
  if (isActive) return 1 + strength * 3;
  if (dimmed) return 0.35 + strength * 0.5 + lightBoost * 0.15;
  return 0.5 + strength * 1.1 + lightBoost * 0.25;
}

export function linkStrokeOpacity(
  weight: number | null | undefined,
  options?: {
    isActive?: boolean;
    dimmed?: boolean;
    range?: { min: number; max: number };
    theme?: BrainLinkTheme;
  },
): number {
  const strength = options?.range
    ? mapWeightToVisualStrength(weight, options.range)
    : normalizeLinkWeight(weight);
  const isLight = options?.theme === "light";
  if (options?.dimmed && !options?.isActive) {
    return isLight ? 0.1 + strength * 0.14 : 0.05 + strength * 0.1;
  }
  if (options?.isActive) return 0.82 + strength * 0.12;
  return isLight ? 0.38 + strength * 0.42 : 0.18 + strength * 0.32;
}

export type BrainLinkTheme = "light" | "dark";

export function getBrainLinkColors(theme: BrainLinkTheme = "dark") {
  if (theme === "dark") {
    return {
      base: "rgba(148, 163, 184, 0.62)",
      active: "rgba(251, 191, 36, 0.9)",
      particleBase: "rgba(148, 163, 184, 0.75)",
      particleActive: "rgba(251, 191, 36, 0.95)",
    };
  }
  return {
    base: "rgba(71, 85, 105, 0.62)",
    active: "rgba(180, 83, 9, 0.92)",
    particleBase: "rgba(71, 85, 105, 0.68)",
    particleActive: "rgba(180, 83, 9, 0.95)",
  };
}

export function getBrainLinkState(params: {
  selectedNodeId: string | null;
  highlightedNodeId?: string | null;
  sourceId: string;
  targetId: string;
}) {
  const { selectedNodeId, highlightedNodeId, sourceId, targetId } = params;
  const touchesSelected =
    selectedNodeId != null &&
    (sourceId === selectedNodeId || targetId === selectedNodeId);
  const isConnectionLink =
    touchesSelected &&
    highlightedNodeId != null &&
    (sourceId === highlightedNodeId || targetId === highlightedNodeId);
  const isActive =
    touchesSelected && (highlightedNodeId == null || isConnectionLink);
  const dimmed =
    selectedNodeId != null &&
    (!touchesSelected ||
      (highlightedNodeId != null && !isConnectionLink));

  return { touchesSelected, isConnectionLink, isActive, dimmed };
}

export function linkWidth3d(
  weight: number | null | undefined,
  isActive: boolean,
  range?: { min: number; max: number },
  dimmed = false,
  theme: BrainLinkTheme = "dark",
): number {
  return linkStrokeWidth(weight, isActive, range, dimmed, theme) * 0.32;
}

export function getBrainLinkWeightRange(
  links: Array<{ weight: number | null | undefined }>,
): { min: number; max: number } {
  if (links.length === 0) return { min: 0.5, max: 0.5 };
  const weights = links.map((link) => normalizeLinkWeight(link.weight));
  return {
    min: Math.min(...weights),
    max: Math.max(...weights),
  };
}
