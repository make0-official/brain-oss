import { MEMORY_CONTENT_MAX_CHARS } from "../shared/limits";
import { MEMORY_ENTITY_TYPES, type MemoryEntityType } from "../shared/types";
import { DEFAULT_CATEGORY_BY_ENTITY, type MemoryClassification } from "../write/classify";
import { type LlmClient, parseJsonObjectLoose } from "./client";

// Prompt and normalization match the Make0 cloud memory classifier.
function buildClassificationPrompt(content: string): string {
  return `Classify this user memory for a personal knowledge graph.

Memory:
${content.slice(0, MEMORY_CONTENT_MAX_CHARS)}

Return ONLY JSON with this exact shape:
{
  "category": "short label",
  "kind": "profile or work",
  "entityType": "preference|person|correction|topic|project|artifact"
}

Rules:
- kind "profile" for identity, preferences, personal facts, and topics they care about
- kind "work" only for creations they made or long-term ventures they run
- entityType "preference" for habits, likes, and personal facts
- entityType "person" for identity or role
- entityType "topic" for subjects they write or care about
- entityType "artifact" with kind work for things they created
- category examples: Preferences, Personal Info, Topics, Creations, Projects, Corrections, Travel Preferences, Content Preferences`;
}

export function parseMemoryClassification(raw: string): MemoryClassification | null {
  const parsed = parseJsonObjectLoose(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const category = typeof record.category === "string" ? record.category.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const kind = record.kind === "work" || record.kind === "profile" ? record.kind : null;
  const entityType =
    typeof record.entityType === "string" && (MEMORY_ENTITY_TYPES as readonly string[]).includes(record.entityType)
      ? (record.entityType as MemoryEntityType)
      : null;
  if (!kind || !entityType) return null;

  const normalizedKind =
    entityType === "preference" || entityType === "person" || entityType === "correction" ||
    (entityType === "artifact" && kind !== "work")
      ? "profile"
      : kind;
  return {
    category: category || DEFAULT_CATEGORY_BY_ENTITY[entityType],
    kind: normalizedKind,
    entityType,
  };
}

export type MemoryClassifier = (content: string) => Promise<MemoryClassification | null>;

export function createMemoryClassifier(client: LlmClient): MemoryClassifier {
  return async (content) => {
    try {
      const raw = await client.completeJson({
        system: "You classify user memories for storage. Return strict JSON only.",
        user: buildClassificationPrompt(content),
        maxTokens: 180,
      });
      return parseMemoryClassification(raw);
    } catch (error) {
      console.error("[make0-brain] classifier failed; using heuristic:", error);
      return null;
    }
  };
}
