import { tokenize } from "../search/lexical";
import { type LlmClient, parseJsonObjectLoose } from "./client";

// Matches the Make0 cloud memory pair judge.
/** LLM calls per write. Further pairs fall back to the heuristic. */
export const MEMORY_PAIR_JUDGE_BUDGET = 8;
const MERGED_CONTENT_MAX_CHARS = 900;

const PAIR_ACTIONS = ["distinct", "merge", "contradict"] as const;
export type MemoryPairAction = (typeof PAIR_ACTIONS)[number];

export type MemoryPairVerdict = {
  action: MemoryPairAction;
  /** Present only when the merge text is entailed by the two inputs. */
  mergedContent?: string;
};

/** Words that do not add a fact. Every other merged token must come from the two memories. */
const MERGE_GLUE_TOKENS = new Set([
  "a", "an", "and", "are", "for", "in", "is", "of", "on", "or", "the", "their", "they", "to", "user", "with",
]);

const PAIR_JUDGE_SYSTEM = `You compare two memories about the same person. Return strict JSON only: {"action":"distinct"|"merge"|"contradict","mergedContent":"..."}.
- distinct: both can be true and they are not the same fact.
- merge: they state the same fact. mergedContent is one sentence using only words from the two memories. Do not add names, dates, places, or preferences that are not already written.
- contradict: they cannot both be true.
Omit mergedContent unless action is merge.`;

function normalizePairText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function memoryPairMergedContentIsEntailed(
  existingContent: string,
  incomingContent: string,
  mergedContent: string,
): boolean {
  const mergedTokens = tokenize(mergedContent);
  if (mergedTokens.length === 0) return false;
  const allowed = new Set([...tokenize(existingContent), ...tokenize(incomingContent)]);
  return mergedTokens.every((token) => allowed.has(token) || MERGE_GLUE_TOKENS.has(token));
}

export function parseMemoryPairVerdict(
  raw: string,
  existingContent: string,
  incomingContent: string,
): MemoryPairVerdict | null {
  const parsed = parseJsonObjectLoose(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const action = (parsed as { action?: unknown }).action;
  if (typeof action !== "string" || !(PAIR_ACTIONS as readonly string[]).includes(action)) return null;
  if (action !== "merge") return { action: action as MemoryPairAction };

  const mergedRaw = (parsed as { mergedContent?: unknown }).mergedContent;
  if (typeof mergedRaw !== "string") return { action: "merge" };
  const mergedContent = normalizePairText(mergedRaw).slice(0, MERGED_CONTENT_MAX_CHARS);
  if (mergedContent.length < 12 || !memoryPairMergedContentIsEntailed(existingContent, incomingContent, mergedContent)) {
    return { action: "merge" };
  }
  return { action: "merge", mergedContent };
}

export type PairJudge = (existingContent: string, incomingContent: string) => Promise<MemoryPairVerdict | null>;

export function createPairJudge(client: LlmClient): PairJudge {
  return async (existingContent, incomingContent) => {
    try {
      const raw = await client.completeJson({
        system: PAIR_JUDGE_SYSTEM,
        user: `Memory A:\n${normalizePairText(existingContent).slice(0, MERGED_CONTENT_MAX_CHARS)}\n\nMemory B:\n${normalizePairText(incomingContent).slice(0, MERGED_CONTENT_MAX_CHARS)}`,
        maxTokens: 400,
        timeoutMs: 12_000,
      });
      return parseMemoryPairVerdict(raw, existingContent, incomingContent);
    } catch (error) {
      console.error("[make0-brain] pair judge failed:", error);
      return null;
    }
  };
}
