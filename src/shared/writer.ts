import {
  MEMORY_ORIGIN_PROVIDERS,
  type MemoryAddedBy,
  type MemoryMetadata,
  type MemoryOriginProvider,
} from "./types";

const ORIGIN_PROVIDERS = new Set<string>(MEMORY_ORIGIN_PROVIDERS);

const ADDED_BY_HOSTS = new Set<MemoryOriginProvider>(["claude", "chatgpt", "cursor", "mcp"]);

/**
 * Claude Desktop's own MCP clients. These ids do not contain the word "claude",
 * so the name regex below would otherwise record the write as a generic MCP app.
 */
const CLAUDE_CLIENT_NAMES = new Set([
  "remote-tools-bridge",
  "cowork-device-dispatch",
  "custom3p-main",
  "custom3p-parked-shell",
  "custom3p-local-exec-consent",
  "custom3p-bootstrap-oidc",
]);

function asOriginProvider(value: string | null | undefined): MemoryOriginProvider {
  if (value && ORIGIN_PROVIDERS.has(value)) return value as MemoryOriginProvider;
  return "make0";
}

/**
 * Map an MCP client name to a writer. Cloud reads the OAuth client name;
 * over stdio we read `clientInfo.name` from `initialize`.
 */
export function detectMcpHost(clientName?: string | null): MemoryOriginProvider {
  const haystack = (clientName ?? "").toLowerCase().trim();
  if (!haystack) return "mcp";
  const first = haystack.split(/\s+/)[0] ?? haystack;
  if (
    CLAUDE_CLIENT_NAMES.has(first) ||
    first.startsWith("cowork-") ||
    first.startsWith("custom3p-") ||
    /claude\.ai|anthropic\.com|\banthropic\b|claude/.test(haystack)
  ) {
    return "claude";
  }
  if (/chatgpt\.com|openai\.com|\bopenai\b|\bchatgpt\b/.test(haystack)) return "chatgpt";
  if (/cursor\.com|cursor\.sh|\bcursor\b/.test(haystack)) return "cursor";
  return "mcp";
}

/** Raw MCP client name to keep when it does not map to Claude, ChatGPT, or Cursor. */
export function normalizeWriterName(value?: string | null): string | null {
  const name = (value ?? "").replace(/\s+/g, " ").trim();
  return name ? name.slice(0, 120) : null;
}

export function mergeMemoryWriterMetadata(
  existing: MemoryMetadata | null | undefined,
  lastUpdatedBy: "user" | "agent" | null,
): MemoryMetadata {
  const metadata: MemoryMetadata = { ...(existing || {}) };
  if (lastUpdatedBy) {
    metadata.lastUpdatedBy = lastUpdatedBy;
  } else {
    delete metadata.lastUpdatedBy;
  }
  return metadata;
}

/** Who first saved the fact: MCP host, Make0 (agent or import), or the user. */
export function resolveMemoryAddedBy(memory: {
  originProvider?: string | null;
  isManuallyAdded?: boolean | null;
  metadata?: MemoryMetadata | null;
}): MemoryAddedBy {
  const origin = memory.originProvider ?? "make0";
  if (ADDED_BY_HOSTS.has(origin as MemoryOriginProvider)) {
    return origin as MemoryOriginProvider;
  }
  if (memory.metadata?.savedBy === "agent") return "make0";
  if (memory.isManuallyAdded) return "user";
  return "make0";
}

/** Writer recorded on a version row. */
export function resolveMemoryWrittenBy(memory: {
  originProvider?: string | null;
  lastWrittenVia?: string | null;
  isManuallyAdded?: boolean | null;
  metadata?: MemoryMetadata | null;
}): MemoryAddedBy {
  const via = asOriginProvider(memory.lastWrittenVia ?? memory.originProvider);
  if (via !== "make0") return via;
  if (memory.metadata?.lastUpdatedBy === "user") return "user";
  if (memory.metadata?.lastUpdatedBy === "agent") return "make0";
  if (memory.isManuallyAdded && memory.metadata?.savedBy !== "agent") return "user";
  return "make0";
}

type VersionFields = {
  content?: string | null;
  category?: string | null;
  kind?: string | null;
  entityType?: string | null;
  confidence?: number | null;
};

/**
 * Content fields that earn a new version (and feed the embedding text).
 * Confidence-only edits do not.
 */
export function memoryVersionFieldsChanged(existing: VersionFields, updates: VersionFields): boolean {
  return (
    (updates.content !== undefined && updates.content !== existing.content) ||
    (updates.category !== undefined && updates.category !== existing.category) ||
    (updates.kind !== undefined && updates.kind !== existing.kind) ||
    (updates.entityType !== undefined && updates.entityType !== existing.entityType)
  );
}
