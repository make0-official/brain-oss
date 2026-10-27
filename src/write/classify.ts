import type { MemoryEntityType, MemoryKind } from "../shared/types";

export type MemoryClassification = {
  category: string;
  kind: MemoryKind;
  entityType: MemoryEntityType;
};

export const DEFAULT_CATEGORY_BY_ENTITY: Record<MemoryEntityType, string> = {
  project: "Projects",
  artifact: "Artifacts",
  source: "Sources",
  workflow: "Workflows",
  preference: "Preferences",
  correction: "Corrections",
  topic: "Topics",
  person: "Personal Info",
};

// Patterns match the Make0 cloud no-key classifier.
const EXPLICIT_IDENTITY_PATTERNS = [
  /\b(?:i am|i'm|im)\s+(?:a|an)\b/i,
  /\bi work (?:as|at|for)\b/i,
  /\bmy (?:role|job|title) is\b/i,
  /\bi (?:run|own|founded)\b/i,
  /\bmy (?:company|startup|brand|audience|niche) is\b/i,
  /\b(?:i live|i'm based|im based|i am based)\b/i,
  /\b(?:i studied|i graduated)\b/i,
];

const EXPLICIT_PREFERENCE_PATTERNS = [
  /\b(?:i|we)\s+(?:prefer|like|love|usually|typically|tend to|always|avoid|hate)\b/i,
  /\b(?:i|we)\s+(?:do not|don't|dont)\s+(?:prefer|like|want)\b/i,
  /\b(?:i|we)\s+would\s+rather\b/i,
];

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function categoryForPreference(text: string): string {
  if (
    /\b(travel|travelling|traveling|trip|car|drive|driving|flight|train|hotel|locations?|distance|km|kilometer|kilometre|mileage|mpg|kmpl)\b/i.test(
      text,
    )
  ) {
    return "Travel Preferences";
  }
  if (/\b(linkedin|instagram|twitter|x post|post|caption|content|writing|tone|style)\b/i.test(text)) {
    return "Content Preferences";
  }
  return "Preferences";
}

/** No-key classifier. A BYO-key LLM classifier can replace it later. */
export function classifyMemoryHeuristic(content: string): MemoryClassification {
  const text = normalizeText(content);

  if (EXPLICIT_IDENTITY_PATTERNS.some((pattern) => pattern.test(text))) {
    return { category: "Personal Info", kind: "profile", entityType: "person" };
  }
  if (EXPLICIT_PREFERENCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { category: categoryForPreference(text), kind: "profile", entityType: "preference" };
  }
  if (/\b(?:created|published|built|made|wrote|designed|launched)\b/i.test(text)) {
    return { category: "Creations", kind: "work", entityType: "artifact" };
  }
  if (/\b(?:correct|actually|instead|rather|not)\b/i.test(text)) {
    return { category: "Corrections", kind: "profile", entityType: "correction" };
  }
  if (/\bmy\s+/i.test(text)) {
    const category = categoryForPreference(text);
    return {
      category: category === "Preferences" ? "Personal Info" : category,
      kind: "profile",
      entityType: "preference",
    };
  }
  return { category: "Personal Info", kind: "profile", entityType: "preference" };
}

/** Fill whatever the caller left out; explicit fields win. */
export function resolveMemoryClassification(
  content: string,
  explicit: Partial<MemoryClassification>,
): MemoryClassification {
  if (explicit.category != null) {
    return {
      category: normalizeText(explicit.category),
      kind: explicit.kind ?? "profile",
      entityType: explicit.entityType ?? "preference",
    };
  }
  const heuristic = classifyMemoryHeuristic(content);
  const entityType = explicit.entityType ?? heuristic.entityType;
  return {
    category: explicit.entityType ? DEFAULT_CATEGORY_BY_ENTITY[entityType] : heuristic.category,
    kind: explicit.kind ?? heuristic.kind,
    entityType,
  };
}
