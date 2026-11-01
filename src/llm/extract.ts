import { MEMORY_ENTITY_TYPES, type MemoryEntityType, type MemoryKind } from "../shared/types";
import { type LlmClient, parseJsonObjectLoose } from "./client";

// Prompt and node rules match Make0 cloud document import.
export const EXTRACT_CHUNK_CHARS = 4_500;
const EXTRACT_MAX_NODES_PER_CHUNK = 80;
const EXTRACT_MAX_CHUNKS_PER_FILE = 16;
const EXTRACTED_CONTENT_MAX_CHARS = 900;

export type ExtractedMemory = {
  content: string;
  category: string;
  kind: MemoryKind;
  entityType: MemoryEntityType;
  confidence: number;
};

/** `session`: a coding-agent session digest rather than the user's own notes. */
export type ExtractSourceKind = "document" | "session";

export type MemoryExtractor = (filename: string, text: string, source?: ExtractSourceKind) => Promise<ExtractedMemory[]>;

const EXTRACT_SYSTEM =
  'You are Make0 Brain. Extract durable, specific facts from a user\'s own notes or agent rule files. Return strict JSON. Never write subject-less fragments like "Is a…" or "Has skills in…".';

function buildDocumentExtractionPrompt(filename: string, chunk: string, maxNodes: number): string {
  return `The following file is the user's own note or AI-agent instruction file. The file is the source of truth — extract durable facts someone could reuse later.

FILE NAME: ${filename}

DOCUMENT:
${chunk}

WHAT A GOOD MEMORY IS:
- A complete sentence with a clear subject.
- Specific: names, employers, titles, places, years, products, tools, conventions, preferences.
- One fact per memory.

SUBJECT:
- If the document names the person, use that name.
- If the document is first-person or gives instructions ("always use pnpm"), use "The user" ("The user prefers pnpm over npm.").
- Never start with a bare verb: "Is…", "Has…", "Works…", "Prefers…".

SPLIT AND SKIP:
- One preference, convention, tool, project, or fact per memory.
- Skip generic filler, boilerplate, navigation, and copyright.
- Skip instructions about this memory tool itself (Make0 Brain).

Do not invent facts. Return at most ${maxNodes} nodes. Empty is fine.

Return ONLY JSON:
{
  "nodes": [
    {
      "content": "The user prefers TypeScript with strict mode for new projects.",
      "category": "Coding Preferences",
      "kind": "profile",
      "entityType": "preference",
      "confidence": 90
    }
  ]
}

Allowed kind: profile, work.
Allowed entityType: preference, person, correction, topic, project, artifact, workflow.`;
}

const SESSION_EXTRACT_SYSTEM =
  "You are Make0 Brain. Extract durable facts from a digest of a user's coding-agent session. Return strict JSON. Most sessions hold few durable facts; empty is fine.";

function buildSessionExtractionPrompt(title: string, chunk: string, maxNodes: number): string {
  return `The following is a digest of one session between the user and a coding agent: what the user asked, their corrections, the files changed, the commands that failed, and how it ended.

SESSION: ${title}

DIGEST:
${chunk}

EXTRACT ONLY WHAT IS STILL TRUE AFTER THIS SESSION:
- The user's preferences and conventions, especially from their corrections ("The user wants pnpm, not npm.").
- Decisions about a project and why ("The checkout service retries Stripe webhooks with exponential backoff.").
- A fix for an error that may come back: the error and what fixed it.
- Facts about the project: stack, structure, where things live, how to run or deploy it.

SKIP:
- The task itself, progress updates, and anything only true during the session.
- Commands that failed and were not fixed, unless the failure itself is a lasting fact.
- Anything the agent said that the user did not confirm.
- Instructions about this memory tool itself (Make0 Brain).

WRITING:
- A complete sentence with a clear subject: "The user …", or the project name.
- One fact per memory. Name the project when the fact is about one.

Do not invent facts. Return at most ${maxNodes} nodes.

Return ONLY JSON:
{
  "nodes": [
    {
      "content": "In the acme-api project, the user runs tests with pnpm vitest, not npm test.",
      "category": "Acme API",
      "kind": "work",
      "entityType": "workflow",
      "confidence": 90
    }
  ]
}

Allowed kind: profile, work.
Allowed entityType: preference, person, correction, topic, project, artifact, workflow.`;
}

export function chunkText(text: string, maxChars: number, maxChunks: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > 0 && chunks.length < maxChunks) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars * 0.4) cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.4) cut = remaining.lastIndexOf(". ", maxChars);
    if (cut < maxChars * 0.4) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/** Drop weak, subject-less, or malformed nodes (same rules as Make0 cloud import). */
export function normalizeExtractedNode(raw: unknown): ExtractedMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const node = raw as Record<string, unknown>;
  const content = String(node.content || "").replace(/\s+/g, " ").trim();
  if (content.length < 22) return null;
  if (/\bthe assistant\b/i.test(content)) return null;
  if (/^(?:is|has|works|worked|lives|prefers)\b/i.test(content)) return null;

  const entityTypeRaw = String(node.entityType || "preference");
  const entityType = (MEMORY_ENTITY_TYPES as readonly string[]).includes(entityTypeRaw)
    ? (entityTypeRaw as MemoryEntityType)
    : "preference";
  const kind: MemoryKind =
    node.kind === "work" && ["project", "artifact", "workflow"].includes(entityType) ? "work" : "profile";
  const confidence =
    typeof node.confidence === "number" && Number.isFinite(node.confidence)
      ? Math.max(0, Math.min(100, Math.round(node.confidence)))
      : 85;
  if (confidence < 75) return null;
  const category = String(node.category || "Preferences").replace(/\s+/g, " ").trim().slice(0, 80) || "Preferences";
  return { content: content.slice(0, EXTRACTED_CONTENT_MAX_CHARS), category, kind, entityType, confidence };
}

export function parseExtractedNodes(raw: string): ExtractedMemory[] {
  const parsed = parseJsonObjectLoose(raw);
  const nodes = parsed && typeof parsed === "object" ? (parsed as { nodes?: unknown }).nodes : null;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => normalizeExtractedNode(node) ?? []);
}

export function createMemoryExtractor(client: LlmClient): MemoryExtractor {
  return async (filename, text, source = "document") => {
    const facts: ExtractedMemory[] = [];
    const seen = new Set<string>();
    for (const chunk of chunkText(text, EXTRACT_CHUNK_CHARS, EXTRACT_MAX_CHUNKS_PER_FILE)) {
      const raw = await client.completeJson({
        system: source === "session" ? SESSION_EXTRACT_SYSTEM : EXTRACT_SYSTEM,
        user:
          source === "session"
            ? buildSessionExtractionPrompt(filename, chunk, EXTRACT_MAX_NODES_PER_CHUNK)
            : buildDocumentExtractionPrompt(filename, chunk, EXTRACT_MAX_NODES_PER_CHUNK),
        maxTokens: 8000,
        timeoutMs: 90_000,
      });
      for (const fact of parseExtractedNodes(raw)) {
        const key = fact.content.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push(fact);
      }
    }
    return facts;
  };
}
