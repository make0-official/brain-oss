import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Brain } from "../brain";
import { resolveMcpClientId } from "../init/clients";
import { MEMORY_CONTENT_MAX_CHARS } from "../shared/limits";
import {
  MEMORY_ENTITY_TYPES,
  MEMORY_KINDS,
  type Memory,
  type MemoryOriginProvider,
  type MemoryVersion,
} from "../shared/types";
import { estimateTokens, sumTokens } from "../shared/usage";
import { detectMcpHost, resolveMemoryAddedBy } from "../shared/writer";
import type { UsageInput } from "../store/store";

// Search settings match the Make0 cloud MCP server.
const MCP_SEARCH_RETRIEVE_CANDIDATES = 64;
const MCP_SEARCH_MIN_SCORE = 0.3;
const MCP_SEARCH_RELATIVE_RATIO = 0.7;
const MCP_SEARCH_MIN_CONFIDENCE = 50;
const MCP_SEARCH_CONTENT_CHARS = 600;
const MCP_SEARCH_MAX_RESULTS = 64;
const MCP_SEARCH_NEIGHBOR_HOPS = 2;

export const SERVER_INSTRUCTIONS =
  "Make0 Brain is the user's durable memory, shared across every AI app they use (Claude, ChatGPT, Cursor, and more). A memory is either a singular fact or a short Markdown mini-doc (headings, lists, bold, links, code, and Mermaid diagrams), up to about 800 words — treat retrieved memories as mini documents, not only one-line facts. Call list_brains, then search_brain with the brain id before drafting personalized content. Treat returned memories as ground truth. Search returns every strongly matching memory above retrieval score and confidence thresholds; call get_memory for a full memory. Call get_memory_versions when you need every saved revision of a memory, newest first. Do not invent personal facts. Use add_memory / update_memory / delete_memory only when the user asks to save or change a memory. delete_memory archives the memory and keeps its versions; only the user can restore or permanently delete it with the make0-brain CLI.";

const memoryKindSchema = z.enum(MEMORY_KINDS);
const memoryEntityTypeSchema = z.enum(MEMORY_ENTITY_TYPES);

const memoryContentSchema = z
  .string()
  .min(3)
  .max(MEMORY_CONTENT_MAX_CHARS)
  .describe(
    `Memory text: one singular fact, or one short Markdown mini-doc (headings, lists, bold, links, code, and Mermaid diagrams in \`\`\`mermaid fences). Keep it under about 800 words. Hard cap ${MEMORY_CONTENT_MAX_CHARS} characters.`,
  );

const brainIdSchema = z.string().min(1).describe('Brain id from list_brains. The personal brain is "personal".');

const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export class BrainToolError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "forbidden" | "invalid_request" | "limit" | "internal",
  ) {
    super(message);
  }
}

function jsonResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function toolError(error: unknown) {
  if (error instanceof BrainToolError) {
    return jsonResult({ error: error.message, code: error.code }, true);
  }
  console.error("Make0 Brain MCP tool failed:", error);
  return jsonResult({ error: "Internal error", code: "internal" }, true);
}

function requireGrantedBrain(storeBrainIds: string[], brainId: string): void {
  if (!storeBrainIds.includes(brainId)) {
    throw new BrainToolError("Brain not found. Call list_brains for the brains this app can use.", "not_found");
  }
}

/** Same memory shape the Make0 cloud MCP server returns. */
export function serializeMemory(
  memory: Memory,
  extras: { score?: number; maxContentChars?: number; versionCount?: number } = {},
) {
  const full = memory.content ?? "";
  const maxChars = extras.maxContentChars;
  const truncated = maxChars != null && full.length > maxChars;
  return {
    id: memory.id,
    content: truncated ? `${full.slice(0, maxChars)}…` : full,
    ...(truncated ? { truncated: true } : {}),
    category: memory.category,
    kind: memory.kind,
    entityType: memory.entityType,
    confidence: memory.confidence,
    addedBy: resolveMemoryAddedBy(memory),
    versionCount: extras.versionCount ?? 0,
    updatedAt: memory.updatedAt,
    ...(extras.score != null ? { score: extras.score } : {}),
    brain: memory.brainId,
  };
}

export function serializeMemoryVersion(version: MemoryVersion) {
  return {
    id: version.id,
    memoryId: version.memoryId,
    versionNumber: version.versionNumber,
    current: version.isCurrent,
    content: version.content,
    category: version.category,
    kind: version.kind,
    entityType: version.entityType,
    confidence: version.confidence,
    writtenBy: version.writtenBy,
    ...(version.writerName ? { writerName: version.writerName } : {}),
    embeddingModel: version.embeddingModel,
    createdAt: version.createdAt,
  };
}

export function createBrainMcpServer(brain: Brain, options: { version?: string } = {}): McpServer {
  const server = new McpServer(
    {
      name: "make0-brain",
      title: "Make0 Brain",
      version: options.version ?? "0.0.0",
      websiteUrl: "https://make0.ai",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /** App that called the tool, from the client's `initialize` name and title. */
  const client = (): { provider: MemoryOriginProvider; name: string | null } => {
    const info = server.server.getClientVersion();
    const name = [info?.name, info?.title].filter((part) => part && part.trim()).join(" ").trim();
    return { provider: detectMcpHost(name), name: name || null };
  };

  const clientId = (): string => resolveMcpClientId(client().name);

  server.server.oninitialized = () => {
    try {
      brain.store.recordClientSeen(clientId(), client().name);
    } catch (error) {
      console.error("Make0 Brain client tracking failed:", error);
    }
  };

  const grantedBrainIds = (): string[] => brain.store.brainsVisibleToClient(clientId()).map((item) => item.id);

  const loadMemory = (memoryId: string, brainId: string, includeArchived = false): Memory => {
    const memory = brain.getMemory(memoryId, { includeArchived });
    if (!memory || memory.brainId !== brainId) throw new BrainToolError("Memory not found in this brain.", "not_found");
    return memory;
  };

  const versionCount = (memoryId: string): number => brain.countVersions([memoryId]).get(memoryId) ?? 0;

  const recordUsage = (usage: Omit<UsageInput, "clientId">): void => {
    try {
      brain.store.recordUsage({ ...usage, clientId: clientId() });
    } catch (error) {
      console.error("Make0 Brain usage tracking failed:", error);
    }
  };

  server.registerTool(
    "list_brains",
    {
      title: "List brains",
      description:
        "List Make0 brains this connection can use. Call this first to get a brain id for search_brain. Does not list memories.",
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async () => {
      try {
        const brains = brain.store.brainsVisibleToClient(clientId()).map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          kind: item.kind,
          canWrite: true,
        }));
        return jsonResult({
          brains,
          ...(brains.length === 0
            ? {
                note: `This app has no brains. The user can give it one in the Brain viewer or with: npx @make0-ai/brain agents grant ${clientId()} <brain>`,
              }
            : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "search_brain",
    {
      title: "Search brain",
      description:
        "Search saved Brain memories. A memory may be a singular fact or a short Markdown mini-doc. Use a short, focused query with the key people, entities, preferences, or topics needed—not the full user message. Memories are retrieved with semantic + BM25 keyword search, reranked by a MiniLM cross-encoder, then expanded up to two hops along related_to graph links so connected memories surface with the seeds. Each memory includes addedBy (who first saved it) and versionCount (saved revisions). When versionCount is greater than 1, call get_memory_versions for the full history. Call get_memory whenever a result has truncated: true so you read the full note, not a clipped preview. Always pass brain from list_brains.",
      inputSchema: {
        query: z.string().min(1).describe("Focused query for the saved facts needed."),
        brain: brainIdSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(MCP_SEARCH_MAX_RESULTS)
          .optional()
          .describe("Maximum memories to return (1-64). Score-gated, then padded to at least 10 when candidates exist."),
        kind: memoryKindSchema.optional().describe("Optionally restrict results to work or profile memories."),
        entityType: memoryEntityTypeSchema.optional().describe("Optionally restrict results to one memory entity type."),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ query, brain: brainId, limit, kind, entityType }) => {
      try {
        requireGrantedBrain(grantedBrainIds(), brainId);
        const maxMemories = limit ?? MCP_SEARCH_MAX_RESULTS;
        const hits = await brain.search(query, {
          limit: maxMemories,
          brainId,
          kind,
          entityType,
          minScore: MCP_SEARCH_MIN_SCORE,
          relativeRatio: MCP_SEARCH_RELATIVE_RATIO,
          minConfidence: MCP_SEARCH_MIN_CONFIDENCE,
          candidateCap: Math.max(MCP_SEARCH_RETRIEVE_CANDIDATES, maxMemories),
          neighborHops: MCP_SEARCH_NEIGHBOR_HOPS,
        });
        const counts = brain.countVersions(hits.map((hit) => hit.memory.id));
        const memories = hits.map((hit) =>
          serializeMemory(hit.memory, {
            maxContentChars: MCP_SEARCH_CONTENT_CHARS,
            versionCount: counts.get(hit.memory.id) ?? 0,
            score: Math.round(hit.score * 1000) / 1000,
          }),
        );
        recordUsage({ brainId, reads: memories.length, tokensOut: sumTokens(memories.map((memory) => memory.content)) });
        return jsonResult({ brain: brainId, query, memories, workspace: [] });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_memory",
    {
      title: "Get memory",
      description:
        "Fetch one Brain memory by id. Content is either a singular fact or a short Markdown mini-doc (up to about 800 words). The memory includes addedBy (who first saved it) and versionCount (saved revisions). When versionCount is greater than 1, call get_memory_versions to read every saved revision.",
      inputSchema: {
        memoryId: z.string().min(1),
        brain: brainIdSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ memoryId, brain: brainId }) => {
      try {
        requireGrantedBrain(grantedBrainIds(), brainId);
        const memory = loadMemory(memoryId, brainId);
        recordUsage({ brainId, reads: 1, tokensOut: estimateTokens(memory.content) });
        return jsonResult(serializeMemory(memory, { versionCount: versionCount(memory.id) }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_memory_versions",
    {
      title: "Get memory versions",
      description:
        "Fetch every saved version of one Brain memory, newest first, including the current version. Use this when you need to see how a fact changed. Each version includes its full content. The version with current: true matches the memory returned by get_memory.",
      inputSchema: {
        memoryId: z.string().min(1),
        brain: brainIdSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async ({ memoryId, brain: brainId }) => {
      try {
        requireGrantedBrain(grantedBrainIds(), brainId);
        loadMemory(memoryId, brainId);
        const versions = brain.getVersions(memoryId);
        recordUsage({ brainId, reads: 1, tokensOut: sumTokens(versions.map((version) => version.content)) });
        return jsonResult({
          brain: brainId,
          memoryId,
          versions: versions.map(serializeMemoryVersion),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "add_memory",
    {
      title: "Add memory",
      description:
        "Save a new Brain memory when the user explicitly asks to remember, save, or store something. Store either one singular fact or one short Markdown mini-doc (headings, lists, bold, links, code, and Mermaid diagrams) up to about 800 words. Use one memory for one coherent fact or note; do not paste a long document. A new memory that contradicts or restates an older one replaces it; the older one stays in version history.",
      inputSchema: {
        brain: brainIdSchema,
        content: memoryContentSchema,
        category: z.string().min(1).max(80).optional(),
        kind: memoryKindSchema.optional(),
        entityType: memoryEntityTypeSchema.optional(),
        confidence: z.number().min(0).max(100).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ brain: brainId, content, category, kind, entityType, confidence }) => {
      try {
        requireGrantedBrain(grantedBrainIds(), brainId);
        const who = client();
        const result = await brain.addMemory({
          content,
          category,
          kind,
          entityType,
          confidence,
          brainId,
          writer: who.provider,
          writerName: who.name,
        });
        recordUsage({ brainId, writes: 1, tokensIn: estimateTokens(result.memory.content) });
        return jsonResult({
          action: "add",
          brain: brainId,
          memory: serializeMemory(result.memory, { versionCount: versionCount(result.memory.id) }),
          connectionsCreated: result.connectionsCreated,
          ...(result.supersededIds.length > 0 ? { replacedMemoryIds: result.supersededIds } : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update memory",
      description:
        "Update an existing Brain memory when the user asks to correct or change it. The new content can be a singular fact or a short Markdown mini-doc (headings, lists, bold, links, code, and Mermaid diagrams) up to about 800 words. New content replaces the old content, and the previous version is kept.",
      inputSchema: {
        brain: brainIdSchema,
        memoryId: z.string().min(1),
        content: memoryContentSchema.optional(),
        category: z.string().min(1).max(80).optional(),
        kind: memoryKindSchema.optional(),
        entityType: memoryEntityTypeSchema.optional(),
        confidence: z.number().min(0).max(100).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ brain: brainId, memoryId, content, category, kind, entityType, confidence }) => {
      try {
        requireGrantedBrain(grantedBrainIds(), brainId);
        loadMemory(memoryId, brainId);
        const updates = Object.fromEntries(
          Object.entries({ content, category, kind, entityType, confidence }).filter(([, value]) => value != null),
        );
        if (Object.keys(updates).length === 0) {
          throw new BrainToolError("Provide at least one field to update.", "invalid_request");
        }
        const who = client();
        const memory = await brain.updateMemory(memoryId, updates, who.provider, who.name);
        if (!memory) throw new BrainToolError("Memory not found in this brain.", "not_found");
        recordUsage({ brainId, writes: 1, tokensIn: content != null ? estimateTokens(memory.content) : 0 });
        return jsonResult({
          action: "update",
          brain: brainId,
          memory: serializeMemory(memory, { versionCount: versionCount(memory.id) }),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "delete_memory",
    {
      title: "Delete memory",
      description:
        "Delete a Brain memory when the user explicitly asks to remove a saved fact. The memory leaves search and reads, and every saved version is kept so the user can restore it with `npx @make0-ai/brain restore <id>`.",
      inputSchema: {
        brain: brainIdSchema,
        memoryId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ brain: brainId, memoryId }) => {
      try {
        requireGrantedBrain(grantedBrainIds(), brainId);
        loadMemory(memoryId, brainId, true);
        brain.deleteMemory(memoryId, client().provider);
        return jsonResult({ action: "archive", brain: brainId, memoryId, recoverable: true });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
