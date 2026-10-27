import { resolveMemoryAddedBy, resolveMemoryWrittenBy } from "../shared/writer";
import type { BrainStore } from "../store/store";
import type { Memory, MemoryAddedBy } from "../shared/types";

const EDIT_THRESHOLD_MS = 2000;

export type ViewMemory = {
  id: string;
  content: string;
  category: string;
  addedBy: MemoryAddedBy;
  updatedBy: MemoryAddedBy;
  /** App name saved with the latest write when `updatedBy` is the generic MCP host. */
  writerName: string | null;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  archived: boolean;
  deletedAt: string | null;
};

export type ViewList = {
  title: string;
  memories: ViewMemory[];
  archived: ViewMemory[];
};

function wasEdited(memory: Memory): boolean {
  const lastUpdatedBy = memory.metadata?.lastUpdatedBy;
  if (lastUpdatedBy === "user" || lastUpdatedBy === "agent") return true;
  const created = new Date(memory.createdAt).getTime();
  const updated = new Date(memory.updatedAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return false;
  return updated - created >= EDIT_THRESHOLD_MS;
}

export function toViewMemory(memory: Memory): ViewMemory {
  const updatedBy = resolveMemoryWrittenBy(memory);
  const writerClient = memory.metadata.writerClient;
  return {
    id: memory.id,
    content: memory.content,
    category: memory.category.trim() || "Uncategorized",
    addedBy: resolveMemoryAddedBy(memory),
    updatedBy,
    writerName: updatedBy === "mcp" && typeof writerClient === "string" ? writerClient : null,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    edited: wasEdited(memory),
    archived: Boolean(memory.deletedAt),
    deletedAt: memory.deletedAt,
  };
}

/** Live memories, plus archived ones the page can recover. Embeddings stay in the database. */
export function buildMemoryList(store: BrainStore): ViewList {
  return {
    title: "Personal brain",
    memories: store.listMemories().map(toViewMemory),
    archived: store.listArchivedMemories().map(toViewMemory),
  };
}
