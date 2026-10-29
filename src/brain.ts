import type { EmbeddingProvider, PairScorer } from "./embeddings/provider";
import { reembedMismatched } from "./embeddings/reembed";
import type { LlmFeatures } from "./llm/features";
import { expandMemoryContextSubgraph, MEMORY_CONTEXT_NEIGHBOR_HOPS, trimMemoryContextEntries } from "./search/graph";
import type { MemoryContextEntry } from "./search/graph";
import { rankMemoriesForQuery } from "./search/rank";
import { memoryDocumentText, normalizeMemoryDocument } from "./shared/limits";
import {
  PERSONAL_BRAIN_ID,
  type Memory,
  type MemoryEntityType,
  type MemoryKind,
  type MemoryMetadata,
  type MemoryOriginProvider,
  type MemoryVersion,
} from "./shared/types";
import { mergeMemoryWriterMetadata } from "./shared/writer";
import type { BrainStore, MemoryUpdates } from "./store/store";
import { resolveMemoryClassification } from "./write/classify";
import { isProtectedFromForget, resolveSupersession } from "./write/contradictions";
import { ensureMemoryGraphLinks } from "./write/links";

/** Auto-extracted memories below this confidence are inactive (cloud prune threshold). */
const MEMORY_CONFIDENCE_PRUNE_THRESHOLD = 20;

export type AddMemoryInput = {
  content: string;
  category?: string;
  kind?: MemoryKind;
  entityType?: MemoryEntityType;
  confidence?: number;
  writer: MemoryOriginProvider;
  /** MCP client name and title, kept when `writer` is the generic `mcp` host. */
  writerName?: string | null;
  metadata?: MemoryMetadata;
  /** False for Make0-side writes such as imports. Default true (user or MCP client asked). */
  isManuallyAdded?: boolean;
  /** Defaults to the personal brain. */
  brainId?: string;
};

export type AddMemoryOptions = {
  /** Precomputed vector (batch imports). */
  embedding?: { embedding: number[]; embeddingModel: string } | null;
  /** Re-run graph link inference after the write. Default true; batch callers call `relink()` once. */
  link?: boolean;
  /**
   * `full` (default): pair judge + heuristic. `heuristic`: no LLM calls
   * (bulk imports). `none`: never archive others (notes imported as documents).
   */
  supersede?: "full" | "heuristic" | "none";
};

export type AddMemoryResult = {
  memory: Memory;
  connectionsCreated: number;
  supersededIds: string[];
};

export type SearchOptions = {
  limit?: number;
  kind?: MemoryKind;
  entityType?: MemoryEntityType;
  minScore?: number;
  relativeRatio?: number;
  minConfidence?: number;
  candidateCap?: number;
  neighborHops?: number;
  /** Defaults to the personal brain. */
  brainId?: string;
};

export type SearchHit = MemoryContextEntry;

function isActiveMemory(memory: Memory): boolean {
  return isProtectedFromForget(memory) || memory.confidence >= MEMORY_CONFIDENCE_PRUNE_THRESHOLD;
}

/**
 * Write pipeline (classify → insert + version → supersede → link) and hybrid
 * search with graph expansion. Each call stays inside one brain.
 */
export class Brain {
  readonly store: BrainStore;
  readonly embeddings: EmbeddingProvider;
  readonly pairScorer?: PairScorer;
  readonly llm: LlmFeatures;

  constructor(options: {
    store: BrainStore;
    embeddings: EmbeddingProvider;
    pairScorer?: PairScorer;
    llm?: LlmFeatures;
  }) {
    this.store = options.store;
    this.embeddings = options.embeddings;
    this.pairScorer = options.pairScorer;
    this.llm = options.llm ?? {};
  }

  /** Embed many texts in one call (import). Null entries mean embedding failed. */
  async embedMany(
    memories: Array<Pick<Memory, "category" | "content" | "kind" | "entityType">>,
  ): Promise<Array<{ embedding: number[]; embeddingModel: string } | null>> {
    try {
      const vectors = await this.embeddings.embed(memories.map(memoryDocumentText));
      return vectors.map((embedding) => (embedding ? { embedding, embeddingModel: this.embeddings.model } : null));
    } catch (error) {
      console.error("[make0-brain] batch embedding failed; memories stay keyword-searchable:", error);
      return memories.map(() => null);
    }
  }

  /** Recompute vector links. One brain, or every brain when `brainId` is omitted. */
  relink(brainId?: string): number {
    const ids = brainId ? [brainId] : this.store.listBrains().map((brain) => brain.id);
    return ids.reduce((sum, id) => sum + ensureMemoryGraphLinks(this.store, { brainId: id }), 0);
  }

  private async embedMemory(memory: Pick<Memory, "category" | "content" | "kind" | "entityType">) {
    try {
      const [embedding] = await this.embeddings.embed([memoryDocumentText(memory)]);
      return embedding ? { embedding, embeddingModel: this.embeddings.model } : null;
    } catch (error) {
      console.error("[make0-brain] embedding failed; memory stays keyword-searchable:", error);
      return null;
    }
  }

  /** Embed memories with no vector or a vector from another model. */
  reembedStale(): Promise<number> {
    return reembedMismatched(this.store, this.embeddings);
  }

  private async classify(content: string, input: AddMemoryInput) {
    if (input.category == null && this.llm.classify) {
      const classified = await this.llm.classify(content);
      if (classified) {
        return {
          category: classified.category,
          kind: input.kind ?? classified.kind,
          entityType: input.entityType ?? classified.entityType,
        };
      }
    }
    return resolveMemoryClassification(content, input);
  }

  async addMemory(input: AddMemoryInput, options: AddMemoryOptions = {}): Promise<AddMemoryResult> {
    const content = normalizeMemoryDocument(input.content);
    const brainId = input.brainId ?? PERSONAL_BRAIN_ID;
    const classification = await this.classify(content, input);
    const embedded =
      options.embedding !== undefined ? options.embedding : await this.embedMemory({ ...classification, content });
    const memory = this.store.createMemory({
      content,
      brainId,
      ...classification,
      confidence: input.confidence ?? 100,
      sourceType: "manual",
      isManuallyAdded: input.isManuallyAdded ?? true,
      metadata: input.metadata ?? {},
      embedding: embedded?.embedding ?? null,
      embeddingModel: embedded?.embeddingModel ?? null,
      originProvider: input.writer,
      lastWrittenVia: input.writer,
      writerName: input.writerName,
    });

    const supersede = options.supersede ?? "full";
    const { archiveIds, mergedContent } =
      supersede === "none"
        ? { archiveIds: [] as string[], mergedContent: undefined }
        : await resolveSupersession(memory, this.store.listMemories({ brainId }), {
            pairScorer: this.pairScorer,
            judge: supersede === "full" ? this.llm.judge : undefined,
          });
    for (const id of archiveIds) this.store.archiveMemory(id, "make0");
    if (mergedContent && mergedContent !== memory.content) {
      // Same as cloud: the merge is a Make0 write on top of the client's version.
      const merged = { ...memory, content: mergedContent };
      const reembedded = await this.embedMemory(merged);
      this.store.updateMemory(memory.id, {
        content: mergedContent,
        lastWrittenVia: "make0",
        metadata: mergeMemoryWriterMetadata({ ...memory.metadata, lastMergedAt: new Date().toISOString() }, "agent"),
        embedding: reembedded?.embedding ?? null,
        embeddingModel: reembedded?.embeddingModel ?? null,
      });
    }

    const connectionsCreated = options.link === false ? 0 : ensureMemoryGraphLinks(this.store, { brainId });
    return { memory: this.store.getMemory(memory.id) ?? memory, connectionsCreated, supersededIds: archiveIds };
  }

  async updateMemory(
    id: string,
    updates: Partial<Pick<Memory, "content" | "category" | "kind" | "entityType" | "confidence">>,
    writer: MemoryOriginProvider,
    writerName?: string | null,
  ): Promise<Memory | undefined> {
    const existing = this.store.getMemory(id);
    if (!existing) return undefined;
    const metadata = mergeMemoryWriterMetadata(existing.metadata, null);
    if (writer === "mcp" && writerName) metadata.writerClient = writerName;
    else delete metadata.writerClient;
    const next: MemoryUpdates = {
      ...updates,
      ...(updates.content != null ? { content: normalizeMemoryDocument(updates.content) } : {}),
      lastWrittenVia: writer,
      writerName,
      metadata,
    };
    const merged = { ...existing, ...next } as Memory;
    const textChanged = memoryDocumentText(merged) !== memoryDocumentText(existing);
    if (textChanged) {
      const embedded = await this.embedMemory(merged);
      next.embedding = embedded?.embedding ?? null;
      next.embeddingModel = embedded?.embeddingModel ?? null;
    }
    const memory = this.store.updateMemory(id, next);
    if (memory && textChanged) ensureMemoryGraphLinks(this.store, { brainId: memory.brainId });
    return memory;
  }

  deleteMemory(id: string, writer: MemoryOriginProvider): boolean {
    return this.store.archiveMemory(id, writer);
  }

  restoreMemory(id: string): Memory | undefined {
    return this.store.restoreMemory(id);
  }

  async restoreVersion(id: string, versionNumber: number): Promise<Memory | undefined> {
    const restored = this.store.restoreVersion(id, versionNumber);
    if (!restored) return undefined;
    const embedded = await this.embedMemory(restored);
    const memory = (embedded ? this.store.updateMemory(id, embedded, { recordVersion: false }) : restored) ?? restored;
    ensureMemoryGraphLinks(this.store, { brainId: memory.brainId });
    return memory;
  }

  purgeMemory(id: string): boolean {
    return this.store.purgeMemory(id);
  }

  getMemory(id: string, options?: { includeArchived?: boolean }): Memory | undefined {
    return this.store.getMemory(id, options);
  }

  getVersions(id: string): MemoryVersion[] {
    return this.store.getVersions(id);
  }

  countVersions(ids: string[]): Map<string, number> {
    return this.store.countVersions(ids);
  }

  /**
   * Same as Make0 cloud MCP search: rank the active
   * set, then expand along strong edges. Recall-all and gap-fill stay off.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    await this.reembedStale();

    const maxMemories = options.limit ?? 25;
    const minScore = options.minScore ?? 0.15;
    const relativeRatio = options.relativeRatio ?? 0.5;
    const neighborHops = options.neighborHops ?? MEMORY_CONTEXT_NEIGHBOR_HOPS;
    const brainId = options.brainId ?? PERSONAL_BRAIN_ID;
    const active = this.store
      .listMemories({ brainId })
      .filter(
        (memory) =>
          isActiveMemory(memory) &&
          (!options.kind || memory.kind === options.kind) &&
          (!options.entityType || memory.entityType === options.entityType) &&
          (options.minConfidence == null ||
            isProtectedFromForget(memory) ||
            memory.confidence >= options.minConfidence),
      );
    if (active.length === 0) return [];

    let queryEmbedding: number[] | null = null;
    try {
      [queryEmbedding] = await this.embeddings.embed([query]);
    } catch (error) {
      console.error("[make0-brain] query embedding failed; using BM25 only:", error);
    }

    const ranked = await rankMemoriesForQuery(
      query,
      active.map((memory) => ({ id: memory.id, text: memory.content, embedding: memory.embedding })),
      {
        queryEmbedding: queryEmbedding ?? null,
        maxResults: maxMemories,
        minScore,
        relativeRatio,
        candidateCap: options.candidateCap,
        pairScorer: this.pairScorer,
        llmHooks: this.llm.retrieval,
      },
    );
    if (ranked.length === 0) return [];

    const memoryById = new Map(active.map((memory) => [memory.id, memory]));
    const edges = this.store.listEdges(brainId);
    const entries: MemoryContextEntry[] =
      edges.length > 0 && neighborHops > 0
        ? expandMemoryContextSubgraph({
            seeds: ranked,
            edges,
            memoryById,
            maxNodes: maxMemories,
            maxHops: neighborHops,
            minScore: Math.max(minScore, (ranked[0]?.score ?? 0) * relativeRatio),
          })
        : ranked.flatMap((entry) => {
            const memory = memoryById.get(entry.id);
            return memory ? [{ memory, score: entry.score, hop: 0, isSeed: true }] : [];
          });
    return trimMemoryContextEntries(entries, maxMemories);
  }
}
