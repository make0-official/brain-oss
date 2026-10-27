import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  Memory,
  MemoryEdge,
  MemoryEntityType,
  MemoryKind,
  MemoryMetadata,
  MemoryOriginProvider,
  MemoryRelationshipType,
  MemorySourceType,
  MemoryVersion,
} from "../shared/types";
import { memoryVersionFieldsChanged, normalizeWriterName, resolveMemoryWrittenBy } from "../shared/writer";
import { migrate } from "./schema";

export type NewMemory = {
  content: string;
  category: string;
  kind: MemoryKind;
  entityType: MemoryEntityType;
  confidence?: number;
  sourceType?: MemorySourceType;
  isManuallyAdded?: boolean;
  metadata?: MemoryMetadata;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  originProvider?: MemoryOriginProvider;
  lastWrittenVia?: MemoryOriginProvider;
  /** MCP `clientInfo` name and title. Kept on the version when the host is generic. */
  writerName?: string | null;
  /** Override timestamps (import, tests). Defaults to now. */
  createdAt?: string;
};

export type MemoryUpdates = Partial<
  Pick<
    Memory,
    | "content"
    | "category"
    | "kind"
    | "entityType"
    | "confidence"
    | "metadata"
    | "embedding"
    | "embeddingModel"
    | "lastWrittenVia"
  >
> & {
  /** MCP client name recorded on the new version. Not a column on `memories`. */
  writerName?: string | null;
};

type MemoryRow = {
  id: string;
  content: string;
  category: string;
  kind: MemoryKind;
  entity_type: MemoryEntityType;
  confidence: number;
  source_type: MemorySourceType;
  is_manually_added: number;
  metadata: string;
  embedding: Buffer | null;
  embedding_model: string | null;
  origin_provider: MemoryOriginProvider;
  last_written_via: MemoryOriginProvider;
  deleted_at: string | null;
  deleted_via: MemoryOriginProvider | null;
  discovered_at: string;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  id: string;
  memory_id: string;
  version_number: number;
  content: string;
  category: string;
  kind: MemoryKind;
  entity_type: MemoryEntityType;
  confidence: number;
  written_by: MemoryVersion["writtenBy"];
  writer_name: string | null;
  is_current: number;
  embedding_model: string | null;
  created_at: string;
};

type EdgeRow = {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relationship_type: MemoryRelationshipType;
  weight: number;
  created_at: string;
  updated_at: string;
};

function encodeEmbedding(embedding: number[] | null | undefined): Buffer | null {
  if (!embedding || embedding.length === 0) return null;
  return Buffer.from(new Float32Array(embedding).buffer);
}

function decodeEmbedding(blob: Buffer | null): number[] | null {
  if (!blob || blob.byteLength === 0) return null;
  const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(floats);
}

function parseMetadata(raw: string): MemoryMetadata {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as MemoryMetadata) : {};
  } catch {
    return {};
  }
}

function clampConfidence(value: unknown, fallback = 75): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    kind: row.kind,
    entityType: row.entity_type,
    confidence: row.confidence,
    sourceType: row.source_type,
    isManuallyAdded: row.is_manually_added === 1,
    metadata: parseMetadata(row.metadata),
    embedding: decodeEmbedding(row.embedding),
    embeddingModel: row.embedding_model,
    originProvider: row.origin_provider,
    lastWrittenVia: row.last_written_via,
    deletedAt: row.deleted_at,
    deletedVia: row.deleted_via,
    discoveredAt: row.discovered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: VersionRow): MemoryVersion {
  return {
    id: row.id,
    memoryId: row.memory_id,
    versionNumber: row.version_number,
    content: row.content,
    category: row.category,
    kind: row.kind,
    entityType: row.entity_type,
    confidence: row.confidence,
    writtenBy: row.written_by,
    writerName: row.writer_name,
    isCurrent: row.is_current === 1,
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
  };
}

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    relationshipType: row.relationship_type,
    weight: row.weight,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Edges are undirected; store endpoints sorted so one pair has one row per type. */
export function sortedEdgeEndpoints(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Synchronous SQLite store for the single local brain.
 * Every content change writes a version; deletes archive.
 */
export class BrainStore {
  readonly db: Database.Database;
  private clock: () => Date;

  constructor(filename: string, options: { now?: () => Date } = {}) {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.clock = options.now ?? (() => new Date());
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return this.clock().toISOString();
  }

  // --- memories ---

  createMemory(input: NewMemory): Memory {
    const id = randomUUID();
    const timestamp = input.createdAt ?? this.now();
    const originProvider = input.originProvider ?? "make0";
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (
            id, content, category, kind, entity_type, confidence, source_type, is_manually_added,
            metadata, embedding, embedding_model, origin_provider, last_written_via,
            discovered_at, created_at, updated_at
          ) VALUES (
            @id, @content, @category, @kind, @entityType, @confidence, @sourceType, @isManuallyAdded,
            @metadata, @embedding, @embeddingModel, @originProvider, @lastWrittenVia,
            @timestamp, @timestamp, @timestamp
          )`,
        )
        .run({
          id,
          content: input.content,
          category: input.category,
          kind: input.kind,
          entityType: input.entityType,
          confidence: clampConfidence(input.confidence),
          sourceType: input.sourceType ?? "manual",
          isManuallyAdded: input.isManuallyAdded ? 1 : 0,
          metadata: JSON.stringify(input.metadata ?? {}),
          embedding: encodeEmbedding(input.embedding),
          embeddingModel: input.embedding ? (input.embeddingModel ?? null) : null,
          originProvider,
          lastWrittenVia: input.lastWrittenVia ?? originProvider,
          timestamp,
        });
      this.recordVersion(this.requireMemory(id, true), timestamp, input.writerName);
    })();
    return this.requireMemory(id, true);
  }

  getMemory(id: string, options: { includeArchived?: boolean } = {}): Memory | undefined {
    const row = this.db
      .prepare(
        options.includeArchived
          ? "SELECT * FROM memories WHERE id = ?"
          : "SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  private requireMemory(id: string, includeArchived = false): Memory {
    const memory = this.getMemory(id, { includeArchived });
    if (!memory) throw new Error(`Memory ${id} not found`);
    return memory;
  }

  /** Live memories, newest first. */
  listMemories(options: { includeArchived?: boolean } = {}): Memory[] {
    const rows = this.db
      .prepare(
        options.includeArchived
          ? "SELECT * FROM memories ORDER BY created_at DESC"
          : "SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY created_at DESC",
      )
      .all() as MemoryRow[];
    return rows.map(rowToMemory);
  }

  listArchivedMemories(): Memory[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
      .all() as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /** Memories imported from one source path, archived included (so re-import skips them). */
  listImportedMemories(sourcePath: string): Memory[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE json_extract(metadata, '$.import.path') = ? ORDER BY created_at")
      .all(sourcePath) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  countMemories(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL")
      .get() as { count: number };
    return row.count;
  }

  /**
   * Apply updates. Writes a new current version when content fields change,
   * unless `recordVersion` is false (embedding backfills, restores).
   */
  updateMemory(
    id: string,
    updates: MemoryUpdates,
    options: { recordVersion?: boolean } = {},
  ): Memory | undefined {
    const existing = this.getMemory(id);
    if (!existing) return undefined;
    const defined = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as MemoryUpdates;
    if (Object.keys(defined).length === 0) return existing;
    const writerName = defined.writerName;
    delete defined.writerName;

    const next: Memory = { ...existing, ...defined, updatedAt: this.now() };
    if (defined.confidence !== undefined) next.confidence = clampConfidence(defined.confidence);
    if ("embedding" in defined && !defined.embedding) next.embeddingModel = null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE memories SET
            content = @content, category = @category, kind = @kind, entity_type = @entityType,
            confidence = @confidence, metadata = @metadata, embedding = @embedding,
            embedding_model = @embeddingModel, last_written_via = @lastWrittenVia, updated_at = @updatedAt
          WHERE id = @id`,
        )
        .run({
          id,
          content: next.content,
          category: next.category,
          kind: next.kind,
          entityType: next.entityType,
          confidence: next.confidence,
          metadata: JSON.stringify(next.metadata ?? {}),
          embedding: encodeEmbedding(next.embedding),
          embeddingModel: next.embeddingModel,
          lastWrittenVia: next.lastWrittenVia,
          updatedAt: next.updatedAt,
        });
      if (options.recordVersion !== false && memoryVersionFieldsChanged(existing, defined)) {
        this.recordVersion(next, next.updatedAt, writerName);
      }
      if ("embedding" in defined || "embeddingModel" in defined) {
        this.db
          .prepare("UPDATE memory_versions SET embedding_model = ? WHERE memory_id = ? AND is_current = 1")
          .run(next.embeddingModel, id);
      }
    })();
    return this.getMemory(id);
  }

  /** Archive: hidden from reads and search, versions kept. Idempotent. */
  archiveMemory(id: string, via: MemoryOriginProvider): boolean {
    const memory = this.getMemory(id, { includeArchived: true });
    if (!memory) return false;
    if (memory.deletedAt) return true;
    this.db
      .prepare("UPDATE memories SET deleted_at = ?, deleted_via = ? WHERE id = ? AND deleted_at IS NULL")
      .run(this.now(), via, id);
    return true;
  }

  restoreMemory(id: string): Memory | undefined {
    this.db.prepare("UPDATE memories SET deleted_at = NULL, deleted_via = NULL WHERE id = ?").run(id);
    return this.getMemory(id);
  }

  /** Permanent delete with versions and edges. Only the user, never an agent. */
  purgeMemory(id: string): boolean {
    return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  // --- versions ---

  private recordVersion(memory: Memory, createdAt: string, writerName?: string | null): void {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version_number), 0) AS max FROM memory_versions WHERE memory_id = ?")
      .get(memory.id) as { max: number };
    this.db.prepare("UPDATE memory_versions SET is_current = 0 WHERE memory_id = ?").run(memory.id);
    const writtenBy = resolveMemoryWrittenBy(memory);
    this.db
      .prepare(
        `INSERT INTO memory_versions (
          id, memory_id, version_number, content, category, kind, entity_type,
          confidence, written_by, writer_name, is_current, embedding_model, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        randomUUID(),
        memory.id,
        row.max + 1,
        memory.content,
        memory.category,
        memory.kind,
        memory.entityType,
        memory.confidence,
        writtenBy,
        writtenBy === "mcp" ? normalizeWriterName(writerName) : null,
        memory.embeddingModel,
        createdAt,
      );
  }

  /** Newest first, current included. */
  getVersions(memoryId: string): MemoryVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version_number DESC")
      .all(memoryId) as VersionRow[];
    return rows.map(rowToVersion);
  }

  countVersions(memoryIds: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (memoryIds.length === 0) return counts;
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT memory_id, COUNT(*) AS count FROM memory_versions
         WHERE memory_id IN (${placeholders}) GROUP BY memory_id`,
      )
      .all(...memoryIds) as Array<{ memory_id: string; count: number }>;
    for (const row of rows) counts.set(row.memory_id, row.count);
    return counts;
  }

  /**
   * Make an older version current and copy its fields onto the memory.
   * Clears the embedding; the caller re-embeds.
   */
  restoreVersion(memoryId: string, versionNumber: number): Memory | undefined {
    const version = this.getVersions(memoryId).find((item) => item.versionNumber === versionNumber);
    if (!version || !this.getMemory(memoryId)) return undefined;
    this.db.transaction(() => {
      this.updateMemory(
        memoryId,
        {
          content: version.content,
          category: version.category,
          kind: version.kind,
          entityType: version.entityType,
          confidence: version.confidence,
          embedding: null,
        },
        { recordVersion: false },
      );
      this.db.prepare("UPDATE memory_versions SET is_current = 0 WHERE memory_id = ?").run(memoryId);
      this.db.prepare("UPDATE memory_versions SET is_current = 1 WHERE id = ?").run(version.id);
    })();
    return this.getMemory(memoryId);
  }

  // --- edges ---

  /** Edges whose endpoints are both live. */
  listEdges(): MemoryEdge[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM memory_edges e
         JOIN memories a ON a.id = e.from_memory_id AND a.deleted_at IS NULL
         JOIN memories b ON b.id = e.to_memory_id AND b.deleted_at IS NULL`,
      )
      .all() as EdgeRow[];
    return rows.map(rowToEdge);
  }

  upsertEdge(edge: {
    fromMemoryId: string;
    toMemoryId: string;
    relationshipType: MemoryRelationshipType;
    weight: number;
  }): void {
    const [fromId, toId] = sortedEdgeEndpoints(edge.fromMemoryId, edge.toMemoryId);
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO memory_edges (id, from_memory_id, to_memory_id, relationship_type, weight, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (from_memory_id, to_memory_id, relationship_type)
         DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), fromId, toId, edge.relationshipType, edge.weight, timestamp, timestamp);
  }

  deleteEdge(id: string): void {
    this.db.prepare("DELETE FROM memory_edges WHERE id = ?").run(id);
  }

  // --- settings ---

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}
