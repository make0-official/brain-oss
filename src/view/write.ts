import { embeddingMatches } from "../embeddings/reembed";
import { embedOne, type EmbeddingProvider } from "../embeddings/provider";
import { MEMORY_CONTENT_MAX_CHARS, memoryDocumentText, normalizeMemoryDocument } from "../shared/limits";
import { mergeMemoryWriterMetadata } from "../shared/writer";
import type { BrainStore } from "../store/store";
import type { MemoryAddedBy } from "../shared/types";
import { resolveMemoryClassification } from "../write/classify";
import { toViewMemory, type ViewMemory } from "./list";

export class ViewInputError extends Error {}

export type ViewVersion = {
  versionNumber: number;
  content: string;
  category: string;
  writtenBy: MemoryAddedBy;
  writerName: string | null;
  isCurrent: boolean;
  embeddingModel: string | null;
  createdAt: string;
};

function readFields(body: unknown, options: { categoryRequired: boolean }): { content: string; category: string | null } {
  if (!body || typeof body !== "object") throw new ViewInputError("Expected a JSON object.");
  const record = body as { content?: unknown; category?: unknown };
  if (typeof record.content !== "string") throw new ViewInputError("Memory text is required.");
  const content = normalizeMemoryDocument(record.content);
  if (content.length < 3) throw new ViewInputError("Memory text must be at least 3 characters.");
  if (content.length > MEMORY_CONTENT_MAX_CHARS) {
    throw new ViewInputError(`Memory text must be at most ${MEMORY_CONTENT_MAX_CHARS} characters.`);
  }
  const category = typeof record.category === "string" ? record.category.replace(/\s+/g, " ").trim() : "";
  if (category.length > 80) throw new ViewInputError("Category must be at most 80 characters.");
  if (options.categoryRequired && !category) throw new ViewInputError("Category is required.");
  return { content, category: category || null };
}

/** Write the current embedder's vector. Does not add a version. */
async function storeViewEmbedding(store: BrainStore, embeddings: EmbeddingProvider, id: string): Promise<void> {
  const memory = store.getMemory(id);
  if (!memory) return;
  const embedding = await embedOne(embeddings, memoryDocumentText(memory));
  if (!embedding) return;
  store.updateMemory(id, { embedding, embeddingModel: embeddings.model }, { recordVersion: false });
}

/** A memory saved from the browser. The first version and its embedding are written immediately. */
export async function createViewMemory(store: BrainStore, body: unknown, embeddings: EmbeddingProvider): Promise<ViewMemory> {
  const fields = readFields(body, { categoryRequired: false });
  const classification = resolveMemoryClassification(fields.content, {
    ...(fields.category ? { category: fields.category } : {}),
  });
  const memory = store.createMemory({
    content: fields.content,
    ...classification,
    confidence: 100,
    sourceType: "manual",
    isManuallyAdded: true,
    metadata: {},
    originProvider: "make0",
    lastWrittenVia: "make0",
  });
  await storeViewEmbedding(store, embeddings, memory.id);
  return toViewMemory(store.getMemory(memory.id) ?? memory);
}

/** Edit the live memory. A changed category or text keeps the previous text as a version and is embedded now. */
export async function updateViewMemory(
  store: BrainStore,
  id: string,
  body: unknown,
  embeddings: EmbeddingProvider,
): Promise<ViewMemory> {
  const existing = store.getMemory(id);
  if (!existing) throw new ViewInputError("Memory not found.");
  const fields = readFields(body, { categoryRequired: true });
  if (fields.content === existing.content && fields.category === existing.category) return toViewMemory(existing);
  const memory = store.updateMemory(id, {
    content: fields.content,
    category: fields.category ?? existing.category,
    embedding: null,
    lastWrittenVia: "make0",
    metadata: mergeMemoryWriterMetadata(existing.metadata, "user"),
  });
  if (!memory) throw new ViewInputError("Memory not found.");
  await storeViewEmbedding(store, embeddings, memory.id);
  return toViewMemory(store.getMemory(memory.id) ?? memory);
}

export function listViewVersions(store: BrainStore, id: string): ViewVersion[] {
  if (!store.getMemory(id, { includeArchived: true })) throw new ViewInputError("Memory not found.");
  return store.getVersions(id).map((version) => ({
    versionNumber: version.versionNumber,
    content: version.content,
    category: version.category,
    writtenBy: version.writtenBy,
    writerName: version.writerName,
    isCurrent: version.isCurrent,
    embeddingModel: version.embeddingModel,
    createdAt: version.createdAt,
  }));
}

/** Hide a memory from the live list. Versions stay, and recover brings it back. */
export function deleteViewMemory(store: BrainStore, id: string): void {
  if (!store.archiveMemory(id, "make0")) throw new ViewInputError("Memory not found.");
}

export type ViewEmbedding = {
  embedder: { name: string; model: string; dimensions: number };
  storedModel: string | null;
  dimensions: number | null;
  values: number[] | null;
  stale: boolean;
  missing: boolean;
};

/** The stored vector for one memory, plus the embedder this process is configured to use. A live memory is re-embedded when its vector is missing or from another model. */
export async function viewMemoryEmbedding(
  store: BrainStore,
  id: string,
  embedder: ViewEmbedding["embedder"],
  embeddings: EmbeddingProvider,
): Promise<ViewEmbedding> {
  const existing = store.getMemory(id, { includeArchived: true });
  if (!existing) throw new ViewInputError("Memory not found.");
  if (!existing.deletedAt && !embeddingMatches(existing.embedding, existing.embeddingModel, embeddings.model)) {
    await storeViewEmbedding(store, embeddings, id);
  }
  const memory = store.getMemory(id, { includeArchived: true }) ?? existing;
  const values = memory.embedding?.map((value) => Math.round(value * 1e6) / 1e6) ?? null;
  return {
    embedder,
    storedModel: memory.embeddingModel,
    dimensions: values?.length ?? null,
    values,
    stale: Boolean(values && memory.embeddingModel !== embedder.model),
    missing: !values,
  };
}

/** Put an archived memory back on the live list. Versions are unchanged. */
export function recoverViewMemory(store: BrainStore, id: string): ViewMemory {
  const existing = store.getMemory(id, { includeArchived: true });
  if (!existing) throw new ViewInputError("Memory not found.");
  if (!existing.deletedAt) return toViewMemory(existing);
  const memory = store.restoreMemory(id);
  if (!memory) throw new ViewInputError("Memory not found.");
  return toViewMemory(memory);
}

/** Erase an archived memory and its versions. Live memories stay until they are archived. */
export function purgeViewMemory(store: BrainStore, id: string): void {
  const existing = store.getMemory(id, { includeArchived: true });
  if (!existing) throw new ViewInputError("Memory not found.");
  if (!existing.deletedAt) throw new ViewInputError("Archive the memory before deleting it permanently.");
  if (!store.purgeMemory(id)) throw new ViewInputError("Memory not found.");
}

/** Make an older saved version the live text and embed that text. Later versions stay in history. */
export async function restoreViewVersion(
  store: BrainStore,
  id: string,
  versionNumber: number,
  embeddings: EmbeddingProvider,
): Promise<ViewMemory> {
  if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new ViewInputError("Version number is invalid.");
  const existing = store.getMemory(id);
  if (!existing) throw new ViewInputError("Memory not found.");
  const current = store.getVersions(id).find((version) => version.versionNumber === versionNumber);
  if (!current) throw new ViewInputError("That version was not found.");
  if (current.isCurrent) return toViewMemory(existing);
  const memory = store.restoreVersion(id, versionNumber);
  if (!memory) throw new ViewInputError("That version was not found.");
  await storeViewEmbedding(store, embeddings, memory.id);
  return toViewMemory(store.getMemory(memory.id) ?? memory);
}
