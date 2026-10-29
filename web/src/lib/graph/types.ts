export interface BrainMemory {
  id: string;
  content: string;
  preview?: string;
  category: string;
  kind: "work" | "profile";
  entityType: string;
  confidence: number;
}

export interface BrainMemoryEdge {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationshipType: string;
  weight: number;
}

export interface MemoryGraph3DHandle {
  resetView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  focusOnNode: (nodeId: string) => void;
}

export function normalizeBrainCategoryLabel(raw: string | null | undefined): string {
  const trimmed = (raw || "").replace(/\s+/g, " ").trim();
  return trimmed || "General";
}

export function cappedPixelRatio() {
  if (typeof window === "undefined") return 1;
  return Math.min(window.devicePixelRatio || 1, 2);
}

function stripMemoryMarkdown(content: string): string {
  return content
    .replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, " $1 ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)?/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)?/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function memoryDisplayText(memory: { content?: string | null; preview?: string | null; category?: string | null }): string {
  const content = stripMemoryMarkdown(memory.content || "");
  if (content) return content;
  const preview = stripMemoryMarkdown(memory.preview || "");
  if (preview) return preview;
  return (memory.category || "").trim() || "Memory";
}
