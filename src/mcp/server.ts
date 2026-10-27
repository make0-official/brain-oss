import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Brain } from "../brain";
import { MEMORY_CONTENT_MAX_CHARS } from "../shared/limits";
import {
  MEMORY_ENTITY_TYPES,
  MEMORY_KINDS,
  PERSONAL_BRAIN_ID,
  type Memory,
  type MemoryOriginProvider,
  type MemoryVersion,
} from "../shared/types";
import { detectMcpHost, resolveMemoryAddedBy } from "../shared/writer";

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

const brainIdSchema = z.string().min(1).describe('Brain id from list_brains. The local brain is "personal".');

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

function requireBrain(brain: string): void {
  if (brain !== PERSONAL_BRAIN_ID) {
    throw new BrainToolError(
      `Brain not found. The local brain is "${PERSONAL_BRAIN_ID}"; multiple brains need Make0 cloud.`,
      "not_found",
    );
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
    brain: PERSONAL_BRAIN_ID,
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

  const loadMemory = (memoryId: string, includeArchived = false): Memory => {
    const memory = brain.getMemory(memoryId, { includeArchived });
    if (!memory) throw new BrainToolError("Memory not found in this brain.", "not_found");
    return memory;
  };

  const versionCount = (memoryId: string): number => brain.countVersions([memoryId]).get(memoryId) ?? 0;

  server.registerTool(
    "list_brains",
    {
      title: "List brains",
      description:
        "List Make0 brains this connection can use. The local server has one personal brain. Call this first to get the brain id for search_brain. Does not list memories.",
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async () => {
      try {
        return jsonResult({
          brains: [
            {
              id: PERSONAL_BRAIN_ID,
              name: "Personal brain",
              description: null,
              kind: "personal",
              canWrite: true,
            },
          ],
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
        requireBrain(brainId);
        const maxMemories = limit ?? MCP_SEARCH_MAX_RESULTS;
        const hits = await brain.search(query, {
          limit: maxMemories,
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
        return jsonResult({ brain: PERSONAL_BRAIN_ID, query, memories, workspace: [] });
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
        requireBrain(brainId);
        const memory = loadMemory(memoryId);
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
        requireBrain(brainId);
        loadMemory(memoryId);
        return jsonResult({
          brain: PERSONAL_BRAIN_ID,
          memoryId,
          versions: brain.getVersions(memoryId).map(serializeMemoryVersion),
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
        requireBrain(brainId);
        const who = client();
        const result = await brain.addMemory({
          content,
          category,
          kind,
          entityType,
          confidence,
          writer: who.provider,
          writerName: who.name,
        });
        return jsonResult({
          action: "add",
          brain: PERSONAL_BRAIN_ID,
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
        requireBrain(brainId);
        loadMemory(memoryId);
        const updates = Object.fromEntries(
          Object.entries({ content, category, kind, entityType, confidence }).filter(([, value]) => value != null),
        );
        if (Object.keys(updates).length === 0) {
          throw new BrainToolError("Provide at least one field to update.", "invalid_request");
        }
        const who = client();
        const memory = await brain.updateMemory(memoryId, updates, who.provider, who.name);
        if (!memory) throw new BrainToolError("Memory not found in this brain.", "not_found");
        return jsonResult({
          action: "update",
          brain: PERSONAL_BRAIN_ID,
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
        requireBrain(brainId);
        loadMemory(memoryId, true);
        brain.deleteMemory(memoryId, client().provider);
        return jsonResult({ action: "archive", brain: PERSONAL_BRAIN_ID, memoryId, recoverable: true });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
