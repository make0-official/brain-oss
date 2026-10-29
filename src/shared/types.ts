/** Default brain. Always present; custom brains are extra rows in the same database. */
export const PERSONAL_BRAIN_ID = "personal";
export const PERSONAL_BRAIN_NAME = "Personal brain";

export const BRAIN_NAME_MAX_LENGTH = 80;
export const BRAIN_DESCRIPTION_MAX_LENGTH = 80;
export const BRAIN_EMOJI_MAX_LENGTH = 16;

export const BRAIN_KINDS = ["personal", "custom"] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];

export type UserBrain = {
  id: string;
  name: string;
  emoji: string | null;
  description: string | null;
  kind: BrainKind;
  createdAt: string;
  updatedAt: string;
};

export type AgentGrant = {
  clientId: string;
  brainId: string;
  createdAt: string;
};

export const MEMORY_KINDS = ["work", "profile"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_ENTITY_TYPES = [
  "project",
  "artifact",
  "source",
  "workflow",
  "preference",
  "correction",
  "topic",
  "person",
] as const;
export type MemoryEntityType = (typeof MEMORY_ENTITY_TYPES)[number];

export const MEMORY_ORIGIN_PROVIDERS = ["make0", "claude", "chatgpt", "cursor", "mcp"] as const;
/** Same enum as cloud `origin_provider`. Widen both sides together. */
export type MemoryOriginProvider = (typeof MEMORY_ORIGIN_PROVIDERS)[number];

export type MemoryAddedBy = "user" | MemoryOriginProvider;

export const MEMORY_RELATIONSHIP_TYPES = [
  "related_to",
  "part_of",
  "produced",
  "references",
  "prefers",
  "corrected_by",
  "works_on",
] as const;
export type MemoryRelationshipType = (typeof MEMORY_RELATIONSHIP_TYPES)[number];

/** Cloud also has message, insight, conversation. OSS only writes manual (imports too). */
export type MemorySourceType = "manual" | "synthesis";

export type MemoryMetadata = {
  lastUpdatedBy?: "user" | "agent";
  savedBy?: "agent";
  lastMergedAt?: string;
  /** Set by `make0-brain import`; `key` is the section within the file. */
  import?: { path: string; hash: string; source: string; key: string; fileHash?: string };
  [key: string]: unknown;
};

export type Memory = {
  id: string;
  brainId: string;
  content: string;
  category: string;
  kind: MemoryKind;
  entityType: MemoryEntityType;
  confidence: number;
  sourceType: MemorySourceType;
  isManuallyAdded: boolean;
  metadata: MemoryMetadata;
  embedding: number[] | null;
  embeddingModel: string | null;
  originProvider: MemoryOriginProvider;
  lastWrittenVia: MemoryOriginProvider;
  deletedAt: string | null;
  deletedVia: MemoryOriginProvider | null;
  discoveredAt: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryVersion = {
  id: string;
  memoryId: string;
  versionNumber: number;
  content: string;
  category: string;
  kind: MemoryKind;
  entityType: MemoryEntityType;
  confidence: number;
  writtenBy: MemoryAddedBy;
  /** MCP client name when `writtenBy` is the generic `mcp` host. */
  writerName: string | null;
  isCurrent: boolean;
  /** Embedder that wrote the vector while this version was current. Null when that was not recorded. */
  embeddingModel: string | null;
  createdAt: string;
};

export type MemoryEdge = {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationshipType: MemoryRelationshipType;
  weight: number;
  createdAt: string;
  updatedAt: string;
};
