import { resolveMemoryAddedBy, resolveMemoryWrittenBy } from "../shared/writer";
import type { BrainStore } from "../store/store";
import { PERSONAL_BRAIN_ID, PERSONAL_BRAIN_NAME, type BrainKind, type Memory, type MemoryAddedBy, type MemoryEdge } from "../shared/types";

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
  brainId: string;
  title: string;
  kind: BrainKind;
  description: string | null;
  emoji: string | null;
  memories: ViewMemory[];
  archived: ViewMemory[];
  edges: ViewEdge[];
};

export type ViewEdge = Pick<MemoryEdge, "id" | "fromMemoryId" | "toMemoryId" | "relationshipType" | "weight">;

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
export function buildMemoryList(store: BrainStore, brainId = PERSONAL_BRAIN_ID): ViewList {
  const brain = store.getBrain(brainId);
  return {
    brainId,
    title: brain?.name ?? PERSONAL_BRAIN_NAME,
    kind: brain?.kind ?? "personal",
    description: brain?.description ?? null,
    emoji: brain?.emoji ?? null,
    memories: store.listMemories({ brainId }).map(toViewMemory),
    archived: store.listArchivedMemories(brainId).map(toViewMemory),
    edges: store.listEdges(brainId).map(({ id, fromMemoryId, toMemoryId, relationshipType, weight }) => ({
      id,
      fromMemoryId,
      toMemoryId,
      relationshipType,
      weight,
    })),
  };
}
