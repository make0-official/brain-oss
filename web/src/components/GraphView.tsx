import { useMemo, useRef } from "react";
import type { Memory, MemoryEdge } from "../lib/api";
import type { BrainMemory, MemoryGraph3DHandle } from "../lib/graph/types";
import { useIsDark } from "../lib/theme";
import { MemoryGraphSphere3D } from "./MemoryGraph3D";

type Props = {
  memories: Memory[];
  edges: MemoryEdge[];
  visibleIds: Set<string> | undefined;
  selectedId: string | null;
  onSelect: (memory: Memory | null) => void;
};

/** Loaded on demand so three.js stays out of the board bundle. */
export default function GraphView({ memories, edges, visibleIds, selectedId, onSelect }: Props) {
  const dark = useIsDark();
  const graphRef = useRef<MemoryGraph3DHandle>(null);
  const byId = useMemo(() => new Map(memories.map((memory) => [memory.id, memory])), [memories]);
  const nodes = useMemo<BrainMemory[]>(
    () =>
      memories.map((memory) => ({
        id: memory.id,
        content: memory.content,
        category: memory.category,
        kind: "work",
        entityType: "memory",
        confidence: 100,
      })),
    [memories],
  );

  return (
    <div className="absolute inset-0">
      <MemoryGraphSphere3D
        ref={graphRef}
        nodes={nodes}
        edges={edges}
        theme={dark ? "dark" : "light"}
        selectedNodeId={selectedId}
        visibleNodeIds={visibleIds}
        onSelect={(node) => onSelect(node ? byId.get(node.id) ?? null : null)}
      />
      <div className="absolute bottom-3 left-1/2 z-[5] flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-slate-300/80 bg-[#fbfaf8]/90 p-1 shadow-[0_12px_32px_rgba(15,23,42,0.08)] backdrop-blur-md dark:border-white/10 dark:bg-[#0d1117]/90">
        <GraphButton label="Zoom out" onClick={() => graphRef.current?.zoomOut()}>
          −
        </GraphButton>
        <GraphButton label="Fit all memories" onClick={() => graphRef.current?.resetView()}>
          Fit
        </GraphButton>
        <GraphButton label="Zoom in" onClick={() => graphRef.current?.zoomIn()}>
          +
        </GraphButton>
      </div>
    </div>
  );
}

function GraphButton({ label, onClick, children }: { label: string; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 min-w-7 cursor-pointer place-items-center rounded-full px-2 text-xs font-semibold text-slate-600 hover:bg-black/[0.05] hover:text-slate-950 dark:text-slate-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
    >
      {children}
    </button>
  );
}
