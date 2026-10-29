import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { findBrain, normalizeBrainDescription, normalizeBrainEmoji, normalizeBrainName } from "../shared/brains";
import {
  PERSONAL_BRAIN_ID,
  type AgentGrant,
  type BrainKind,
  type Memory,
  type MemoryEdge,
  type MemoryEntityType,
  type MemoryKind,
  type MemoryMetadata,
  type MemoryOriginProvider,
  type MemoryRelationshipType,
  type MemorySourceType,
  type MemoryVersion,
  type UserBrain,
} from "../shared/types";
import { memoryVersionFieldsChanged, normalizeWriterName, resolveMemoryWrittenBy } from "../shared/writer";
import { migrate } from "./schema";

export class BrainStoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "in_use" | "protected",
  ) {
    super(message);
  }
}

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
  /** Defaults to the personal brain. */
  brainId?: string;
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
  brain_id: string;
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

type BrainRow = {
  id: string;
  name: string;
  emoji: string | null;
  description: string | null;
  kind: BrainKind;
  created_at: string;
  updated_at: string;
};

type GrantRow = {
  client_id: string;
  brain_id: string;
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

function rowToBrain(row: BrainRow): UserBrain {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    description: row.description,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToGrant(row: GrantRow): AgentGrant {
  return { clientId: row.client_id, brainId: row.brain_id, createdAt: row.created_at };
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    brainId: row.brain_id,
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
 * Synchronous SQLite store for every local brain.
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
    const brainId = input.brainId ?? PERSONAL_BRAIN_ID;
    if (!this.getBrain(brainId)) throw new BrainStoreError(`Brain not found: ${brainId}`, "not_found");
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (
            id, content, category, kind, entity_type, confidence, source_type, is_manually_added,
            metadata, embedding, embedding_model, origin_provider, last_written_via,
            discovered_at, created_at, updated_at, brain_id
          ) VALUES (
            @id, @content, @category, @kind, @entityType, @confidence, @sourceType, @isManuallyAdded,
            @metadata, @embedding, @embeddingModel, @originProvider, @lastWrittenVia,
            @timestamp, @timestamp, @timestamp, @brainId
          )`,
        )
        .run({
          id,
          brainId,
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

  /** Live memories, newest first. `brainId` limits the list to one brain. */
  listMemories(options: { includeArchived?: boolean; brainId?: string } = {}): Memory[] {
    const where: string[] = [];
    const params: string[] = [];
    if (!options.includeArchived) where.push("deleted_at IS NULL");
    if (options.brainId) {
      where.push("brain_id = ?");
      params.push(options.brainId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM memories ${clause} ORDER BY created_at DESC`).all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  listArchivedMemories(brainId?: string): Memory[] {
    const rows = (
      brainId
        ? this.db
            .prepare("SELECT * FROM memories WHERE deleted_at IS NOT NULL AND brain_id = ? ORDER BY deleted_at DESC")
            .all(brainId)
        : this.db.prepare("SELECT * FROM memories WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all()
    ) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /** Memories imported from one source path, archived included (so re-import skips them). */
  listImportedMemories(sourcePath: string, brainId?: string): Memory[] {
    const rows = (
      brainId
        ? this.db
            .prepare(
              "SELECT * FROM memories WHERE json_extract(metadata, '$.import.path') = ? AND brain_id = ? ORDER BY created_at",
            )
            .all(sourcePath, brainId)
        : this.db
            .prepare("SELECT * FROM memories WHERE json_extract(metadata, '$.import.path') = ? ORDER BY created_at")
            .all(sourcePath)
    ) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  countMemories(options: { brainId?: string; includeArchived?: boolean } = {}): number {
    const where: string[] = [];
    const params: string[] = [];
    if (!options.includeArchived) where.push("deleted_at IS NULL");
    if (options.brainId) {
      where.push("brain_id = ?");
      params.push(options.brainId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM memories ${clause}`).get(...params) as { count: number };
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

  /** Edges whose endpoints are both live. `brainId` keeps edges inside that brain. */
  listEdges(brainId?: string): MemoryEdge[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM memory_edges e
         JOIN memories a ON a.id = e.from_memory_id AND a.deleted_at IS NULL
         JOIN memories b ON b.id = e.to_memory_id AND b.deleted_at IS NULL
         WHERE (? IS NULL OR (a.brain_id = ? AND b.brain_id = ?))`,
      )
      .all(brainId ?? null, brainId ?? null, brainId ?? null) as EdgeRow[];
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

  // --- brains ---

  listBrains(): UserBrain[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM brains
         ORDER BY CASE kind WHEN 'personal' THEN 0 ELSE 1 END, created_at ASC, name ASC`,
      )
      .all() as BrainRow[];
    return rows.map(rowToBrain);
  }

  getBrain(id: string): UserBrain | undefined {
    const row = this.db.prepare("SELECT * FROM brains WHERE id = ?").get(id) as BrainRow | undefined;
    return row ? rowToBrain(row) : undefined;
  }

  /** Id, or the only brain with that name. */
  resolveBrain(ref: string): UserBrain | undefined {
    return findBrain(this, ref);
  }

  createBrain(input: { name: string; emoji?: string | null; description?: string | null }): UserBrain {
    const name = normalizeBrainName(input.name);
    if (!name) throw new BrainStoreError("Brain name is required.", "invalid");
    const id = randomUUID();
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO brains (id, name, emoji, description, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'custom', ?, ?)`,
      )
      .run(id, name, normalizeBrainEmoji(input.emoji), normalizeBrainDescription(input.description), timestamp, timestamp);
    return this.requireBrain(id);
  }

  updateBrain(
    id: string,
    updates: { name?: string; emoji?: string | null; description?: string | null },
  ): UserBrain {
    const existing = this.getBrain(id);
    if (!existing) throw new BrainStoreError("Brain not found.", "not_found");
    if (existing.kind === "personal" && (updates.name !== undefined || updates.emoji !== undefined)) {
      throw new BrainStoreError("The personal brain name cannot be changed.", "protected");
    }
    const name = updates.name !== undefined ? normalizeBrainName(updates.name) : existing.name;
    if (!name) throw new BrainStoreError("Brain name is required.", "invalid");
    const emoji = updates.emoji !== undefined ? normalizeBrainEmoji(updates.emoji) : existing.emoji;
    const description =
      updates.description !== undefined ? normalizeBrainDescription(updates.description) : existing.description;
    this.db
      .prepare("UPDATE brains SET name = ?, emoji = ?, description = ?, updated_at = ? WHERE id = ?")
      .run(name, emoji, description, this.now(), id);
    return this.requireBrain(id);
  }

  /** Custom brains only, and only when they hold no memories. */
  deleteBrain(id: string): void {
    const existing = this.getBrain(id);
    if (!existing) throw new BrainStoreError("Brain not found.", "not_found");
    if (existing.kind === "personal") throw new BrainStoreError("The personal brain cannot be deleted.", "protected");
    const count = this.countMemories({ brainId: id, includeArchived: true });
    if (count > 0) {
      throw new BrainStoreError(
        `This brain still has ${count} ${count === 1 ? "memory" : "memories"}. Purge them before deleting the brain.`,
        "in_use",
      );
    }
    this.db.prepare("DELETE FROM brains WHERE id = ?").run(id);
  }

  private requireBrain(id: string): UserBrain {
    const brain = this.getBrain(id);
    if (!brain) throw new BrainStoreError("Brain not found.", "not_found");
    return brain;
  }

  // --- agent grants ---

  listAgentGrants(): AgentGrant[] {
    const rows = this.db
      .prepare("SELECT client_id, brain_id, created_at FROM agent_grants ORDER BY client_id, brain_id")
      .all() as GrantRow[];
    return rows.map(rowToGrant);
  }

  /** Explicit grant rows. Empty can mean "never configured" or "no brains"; see `isClientConfigured`. */
  grantBrainIds(clientId: string): string[] {
    const rows = this.db
      .prepare("SELECT brain_id FROM agent_grants WHERE client_id = ? ORDER BY brain_id")
      .all(clientId) as Array<{ brain_id: string }>;
    return rows.map((row) => row.brain_id);
  }

  /** True once the client's access was set. Unconfigured clients see the personal brain only. */
  isClientConfigured(clientId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM agent_access WHERE client_id = ?").get(clientId));
  }

  /** Clients whose access was set, including those left with no brains. */
  listConfiguredClientIds(): string[] {
    const rows = this.db.prepare("SELECT client_id FROM agent_access ORDER BY client_id").all() as Array<{ client_id: string }>;
    return rows.map((row) => row.client_id);
  }

  /** Brains this MCP client may use: personal when never configured, otherwise its grants, possibly none. */
  brainsVisibleToClient(clientId: string): UserBrain[] {
    if (!this.isClientConfigured(clientId)) {
      return this.listBrains().filter((brain) => brain.id === PERSONAL_BRAIN_ID);
    }
    const granted = new Set(this.grantBrainIds(clientId));
    return this.listBrains().filter((brain) => granted.has(brain.id));
  }

  /**
   * Clients that can use this brain. Unconfigured clients can use personal,
   * so pass the known client ids to include that implicit access.
   */
  clientIdsForBrain(brainId: string, knownClientIds: string[] = []): string[] {
    const explicit = this.listAgentGrants()
      .filter((grant) => grant.brainId === brainId)
      .map((grant) => grant.clientId);
    if (brainId !== PERSONAL_BRAIN_ID) return explicit;
    const configured = new Set(this.listConfiguredClientIds());
    const implicit = knownClientIds.filter((id) => !configured.has(id));
    return [...new Set([...implicit, ...explicit])];
  }

  /** Replace one client's grants. An empty list leaves the client with no brains. */
  setClientBrains(clientId: string, brainIds: string[]): void {
    const ids = [...new Set(brainIds.map((id) => id.trim()).filter(Boolean))];
    if (!clientId.trim()) throw new BrainStoreError("Agent id is required.", "invalid");
    for (const id of ids) {
      if (!this.getBrain(id)) throw new BrainStoreError(`Brain not found: ${id}`, "not_found");
    }
    const timestamp = this.now();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_grants WHERE client_id = ?").run(clientId);
      const insert = this.db.prepare(
        "INSERT INTO agent_grants (client_id, brain_id, created_at) VALUES (?, ?, ?)",
      );
      for (const id of ids) insert.run(clientId, id, timestamp);
      this.db
        .prepare(
          `INSERT INTO agent_access (client_id, updated_at) VALUES (?, ?)
           ON CONFLICT (client_id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(clientId, timestamp);
    })();
  }

  /** Add one brain to a client, on top of what it can already see. */
  grantClientBrain(clientId: string, brainId: string): void {
    if (!this.getBrain(brainId)) throw new BrainStoreError(`Brain not found: ${brainId}`, "not_found");
    const current = this.brainsVisibleToClient(clientId).map((brain) => brain.id);
    if (current.includes(brainId) && this.isClientConfigured(clientId)) return;
    this.setClientBrains(clientId, [...new Set([...current, brainId])]);
  }

  /** Remove one brain from a client. Removing the last one leaves it with no brains. */
  revokeClientBrain(clientId: string, brainId: string): void {
    const current = this.brainsVisibleToClient(clientId).map((brain) => brain.id);
    this.setClientBrains(
      clientId,
      current.filter((id) => id !== brainId),
    );
  }

  // --- MCP clients ---

  /** Remembers an app that connected over MCP, so the viewer can list it by id. */
  recordClientSeen(id: string, name: string | null): void {
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO mcp_clients (id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = COALESCE(excluded.name, name), last_seen_at = excluded.last_seen_at`,
      )
      .run(id, name, timestamp, timestamp);
  }

  listSeenClients(): SeenClient[] {
    const rows = this.db
      .prepare("SELECT id, name, first_seen_at, last_seen_at FROM mcp_clients ORDER BY last_seen_at DESC")
      .all() as Array<{ id: string; name: string | null; first_seen_at: string; last_seen_at: string }>;
    return rows.map((row) => ({ id: row.id, name: row.name, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at }));
  }

  // --- usage ---

  /** Adds to today's UTC counters for one client and brain. */
  recordUsage(input: UsageInput): void {
    const amounts = [input.reads, input.writes, input.tokensIn, input.tokensOut].map((value) =>
      Math.max(0, Math.floor(value ?? 0)),
    );
    if (amounts.every((value) => value === 0) || !this.getBrain(input.brainId)) return;
    this.db
      .prepare(
        `INSERT INTO usage_daily (client_id, brain_id, day, reads, writes, tokens_in, tokens_out)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_id, brain_id, day) DO UPDATE SET
           reads = reads + excluded.reads,
           writes = writes + excluded.writes,
           tokens_in = tokens_in + excluded.tokens_in,
           tokens_out = tokens_out + excluded.tokens_out`,
      )
      .run(input.clientId, input.brainId, this.now().slice(0, 10), ...amounts);
  }

  /** Daily rows from `since` (YYYY-MM-DD, inclusive). */
  listUsage(since: string): UsageRow[] {
    const rows = this.db
      .prepare(
        "SELECT client_id, brain_id, day, reads, writes, tokens_in, tokens_out FROM usage_daily WHERE day >= ? ORDER BY day, client_id, brain_id",
      )
      .all(since) as Array<{
      client_id: string;
      brain_id: string;
      day: string;
      reads: number;
      writes: number;
      tokens_in: number;
      tokens_out: number;
    }>;
    return rows.map((row) => ({
      clientId: row.client_id,
      brainId: row.brain_id,
      day: row.day,
      reads: row.reads,
      writes: row.writes,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
    }));
  }
}

export type SeenClient = { id: string; name: string | null; firstSeenAt: string; lastSeenAt: string };

export type UsageInput = {
  clientId: string;
  brainId: string;
  reads?: number;
  writes?: number;
  tokensIn?: number;
  tokensOut?: number;
};

export type UsageRow = {
  clientId: string;
  brainId: string;
  day: string;
  reads: number;
  writes: number;
  tokensIn: number;
  tokensOut: number;
};
