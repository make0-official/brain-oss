export type BrainGraphThemeMode = "light" | "dark";

export function getBrainGraphBackground(theme: BrainGraphThemeMode): string {
  return theme === "dark" ? "#05070b" : "#f1efea";
}

/** Graph canvas fill — slightly darker than page chrome in light mode. */
export const BRAIN_MODAL_CANVAS_BG = "bg-[#f1efea] dark:bg-[#080a0e]";

/** Shared fill for the bottom dock, map controls, and Ask Agent — same as linear chat. */
export const BRAIN_MODAL_CHROME_BG = "bg-[#fbfaf8] dark:bg-[#080a0e]";

/** Fixed viewport grid for the 2D Brain canvas. */
export function getBrainGraphGridStyle(theme: BrainGraphThemeMode): {
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
} {
  const fine =
    theme === "dark" ? "rgba(226, 232, 240, 0.035)" : "rgba(15, 23, 42, 0.045)";
  const coarse =
    theme === "dark" ? "rgba(226, 232, 240, 0.06)" : "rgba(15, 23, 42, 0.07)";
  return {
    backgroundImage: [
      `linear-gradient(to right, ${fine} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${fine} 1px, transparent 1px)`,
      `linear-gradient(to right, ${coarse} 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${coarse} 1px, transparent 1px)`,
    ].join(", "),
    backgroundSize: "28px 28px, 28px 28px, 140px 140px, 140px 140px",
    backgroundPosition: "center center",
  };
}

export interface BrainGraphUiTheme {
  background: string;
  title: string;
  subtitle: string;
  muted: string;
  faint: string;
  body: string;
  bodySecondary: string;
  panel: string;
  controlGroup: string;
  controlBtn: string;
  controlBtnActive: string;
  iconBtn: string;
  input: string;
  badge: string;
  inset: string;
  kbd: string;
  divider: string;
  verticalDivider: string;
  connectionRow: string;
  connectionRowHover: string;
  connectionText: string;
  strengthBadge: string;
  popover: string;
  actionBtn: string;
  dangerBtn: string;
  dangerIconBtn: string;
  emptyState: string;
  warningBanner: string;
  mapControlBtn: string;
  timeMachineTitle: string;
  categoryLabel: string;
  dropShadowTitle: string;
  dropShadowSubtitle: string;
  nodeCard: string;
  nodeCardSelected: string;
  nodeCardNeighbor: string;
  nodeCardConnection: string;
  nodeCardDefault: string;
  nodeContent: string;
  nodeCategory: string;
  memoryBadge: string;
  nodeStroke: string;
  nodeSocketFill: string | null;
  nodeSocketStroke: string | null;
  guideRing: string;
  dimmedNodeStroke: string;
  labelSpriteStroke: string;
  labelSpriteFill: string;
  sphereDimmedNode: string;
}

export function getBrainGraphUiTheme(
  theme: BrainGraphThemeMode,
): BrainGraphUiTheme {
  if (theme === "dark") {
    return {
      background: getBrainGraphBackground("dark"),
      title: "text-white",
      subtitle: "text-slate-300",
      muted: "text-slate-400",
      faint: "text-slate-500",
      body: "text-white",
      bodySecondary: "text-slate-200",
      panel: "border-[#30363d] bg-[#06080c]",
      controlGroup: "bg-[#161b22]",
      controlBtn: "text-slate-300 hover:bg-white/10 hover:text-white",
      controlBtnActive: "bg-white/15 text-white",
      iconBtn: "bg-[#161b22] text-slate-300 hover:bg-white/10 hover:text-white",
      input:
        "border-[#30363d] bg-[#161b22] text-white placeholder:text-slate-500 focus-visible:ring-white/20",
      badge: "bg-white/10 text-slate-300",
      inset: "bg-white/5",
      kbd: "border-white/15 bg-white/5 text-slate-300",
      divider: "border-white/10",
      verticalDivider: "border-white/10",
      connectionRow: "bg-white/5",
      connectionRowHover: "bg-amber-400/10 ring-1 ring-amber-400/35",
      connectionText: "text-slate-300 hover:text-white",
      strengthBadge:
        "bg-white/10 text-amber-300/90 hover:bg-white/15 hover:text-amber-200",
      popover: "border-[#30363d] bg-[#06080c] text-white",
      actionBtn: "bg-white/10 text-white hover:bg-white/15 hover:text-white",
      dangerBtn: "text-red-300 hover:bg-red-500/10 hover:text-red-200",
      dangerIconBtn:
        "text-slate-400 hover:bg-white/10 hover:text-red-300",
      emptyState: "border-[#30363d] bg-[#161b22] text-slate-300",
      warningBanner: "border-amber-400/30 bg-amber-950 text-amber-100",
      mapControlBtn: "bg-white/10 text-white hover:bg-white/15",
      timeMachineTitle: "text-white",
      categoryLabel: "text-amber-400/90",
      dropShadowTitle: "drop-shadow-[0_1px_6px_rgba(0,0,0,0.7)]",
      dropShadowSubtitle: "drop-shadow-[0_1px_4px_rgba(0,0,0,0.6)]",
      nodeCard: "bg-[#06080c]",
      nodeCardSelected:
        "border-white/60 ring-2 ring-white/50 shadow-[0_0_28px_rgba(255,255,255,0.22)]",
      nodeCardNeighbor: "border-white/25 ring-1 ring-white/15",
      nodeCardConnection:
        "border-amber-300/50 ring-2 ring-amber-300/35 shadow-[0_0_20px_rgba(251,191,36,0.18)]",
      nodeCardDefault: "border-white/10",
      nodeContent: "text-slate-200",
      nodeCategory: "font-semibold",
      memoryBadge: "text-slate-950",
      nodeStroke: "rgba(255,255,255,0.5)",
      nodeSocketFill: null,
      nodeSocketStroke: null,
      guideRing: "rgba(255,255,255,0.04)",
      dimmedNodeStroke: "rgba(255,255,255,0.9)",
      labelSpriteStroke: "rgba(2, 6, 23, 0.92)",
      labelSpriteFill: "rgba(248, 250, 252, 0.96)",
      sphereDimmedNode: "rgba(148, 163, 184, 0.45)",
    };
  }

  return {
    background: getBrainGraphBackground("light"),
    title: "text-slate-950",
    subtitle: "text-slate-700",
    muted: "text-slate-700",
    faint: "text-slate-600",
    body: "text-slate-950",
    bodySecondary: "text-slate-800",
    panel: "border-[#d0d7de] bg-[#fbfaf8] shadow-lg",
    controlGroup: "border border-slate-400 bg-white shadow-md",
    controlBtn: "text-slate-800 hover:bg-slate-100 hover:text-slate-950",
    controlBtnActive: "bg-slate-300 text-slate-950 shadow-sm",
    iconBtn:
      "border border-slate-400 bg-white text-slate-800 hover:bg-slate-100 hover:text-slate-950",
    input:
      "border-slate-400 bg-white text-slate-950 placeholder:text-slate-500 focus-visible:ring-slate-500",
    badge: "bg-slate-300 text-slate-800",
    inset: "bg-slate-100",
    kbd: "border-slate-400 bg-slate-50 text-slate-800",
    divider: "border-slate-400",
    verticalDivider: "border-slate-400",
    connectionRow: "bg-slate-100",
    connectionRowHover: "bg-amber-100 ring-1 ring-amber-500/50",
    connectionText: "text-slate-800 hover:text-slate-950",
    strengthBadge:
      "border border-amber-400 bg-amber-100 text-amber-950 hover:bg-amber-200",
    popover: "border-slate-400 bg-white text-slate-950 shadow-lg",
    actionBtn:
      "bg-slate-300 text-slate-950 hover:bg-slate-400 hover:text-slate-950",
    dangerBtn: "text-red-700 hover:bg-red-50 hover:text-red-800",
    dangerIconBtn: "text-slate-700 hover:bg-slate-100 hover:text-red-700",
    emptyState: "border-slate-400 bg-white text-slate-800 shadow-md",
    warningBanner: "border-amber-500 bg-amber-100 text-amber-950",
    mapControlBtn: "bg-slate-300 text-slate-950 hover:bg-slate-400",
    timeMachineTitle: "text-slate-950",
    categoryLabel: "text-amber-950 font-medium",
    dropShadowTitle: "drop-shadow-[0_1px_3px_rgba(255,255,255,0.95)]",
    dropShadowSubtitle: "drop-shadow-[0_1px_2px_rgba(255,255,255,0.9)]",
      nodeCard: "bg-white shadow-md",
    nodeCardSelected:
      "border-slate-600 ring-2 ring-slate-500/80 shadow-[0_4px_24px_rgba(15,23,42,0.22)]",
    nodeCardNeighbor: "border-slate-500 ring-1 ring-slate-400/70",
    nodeCardConnection:
      "border-amber-600 ring-2 ring-amber-500/70 shadow-[0_4px_20px_rgba(180,83,9,0.25)]",
    nodeCardDefault: "border-slate-400",
    nodeContent: "text-slate-900",
    nodeCategory: "font-bold tracking-[0.1em]",
    memoryBadge: "text-white ring-2 ring-white shadow-sm",
    nodeStroke: "rgba(255,255,255,0.95)",
    nodeSocketFill: "#cfd6e0",
    nodeSocketStroke: "rgba(148, 163, 184, 0.85)",
    guideRing: "rgba(15,23,42,0.14)",
    dimmedNodeStroke: "rgba(71, 85, 105, 0.55)",
    labelSpriteStroke: "rgba(255, 255, 255, 0.98)",
    labelSpriteFill: "rgba(15, 23, 42, 0.94)",
    sphereDimmedNode: "rgba(71, 85, 105, 0.72)",
  };
}
