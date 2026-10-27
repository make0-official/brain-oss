import type { PairScorer } from "../embeddings/provider";
import { MEMORY_PAIR_JUDGE_BUDGET, type PairJudge } from "../llm/judge";
import { lexicalSimilarity } from "../search/lexical";
import { memoryDocumentText } from "../shared/limits";
import type { Memory } from "../shared/types";

// Thresholds match Make0 cloud contradiction checks.
const CONTRADICTION_TOPIC_OVERLAP_MIN = 0.28;
const CONTRADICTION_CORRECTION_OVERLAP_MIN = 0.22;
const CONTRADICTION_CROSS_ENCODER_MIN = 0.52;
const CONTRADICTION_CROSS_ENCODER_PREFILTER = 0.18;
/** Lexical overlap that earns a pair-judge call. */
const MEMORY_MERGE_LEXICAL_PREFILTER = 0.4;

type MemoryPolarity = "positive" | "negative" | "neutral";

// Cloud patterns are third person ("the user prefers"); MCP agents also write first person.
const MEMORY_NEGATIVE_PATTERNS = [
  /\b(?:the user|i|we)\s+(?:avoids?|dislikes?|hates?)\b/i,
  /\b(?:the user|i|we)\s+(?:does not|do not|doesn't|don't)\s+(?:prefer|like|want|use)\b/i,
  /\b(?:the user|i|we)\s+would not\b/i,
  /\bno longer\b/i,
  /\bstopped\b/i,
  /\bnever (?:uses?|prefers?)\b/i,
];

const MEMORY_POSITIVE_PATTERNS = [
  /\b(?:the user|i|we)\s+(?:prefers?|likes?|loves?|usually|typically|tends? to|always)\b/i,
  /\b(?:the user|i|we)\s+would rather\b/i,
];

const POLARITY_PREFIX =
  /^(?:the user|i|we)\s+(?:prefers?|likes?|loves?|usually|typically|tends? to|always|avoids?|dislikes?|hates?|does not prefer|do not prefer|does not like|do not like|don't like|doesn't like|would rather|would not)\s+/i;

function getMemoryPolarity(content: string): MemoryPolarity {
  if (MEMORY_NEGATIVE_PATTERNS.some((pattern) => pattern.test(content))) return "negative";
  if (MEMORY_POSITIVE_PATTERNS.some((pattern) => pattern.test(content))) return "positive";
  return "neutral";
}

function stripPolarityMarkers(content: string): string {
  return content.replace(POLARITY_PREFIX, "").trim();
}

/** User-authored or MCP-client memories are protected from automatic archive. */
export function isProtectedFromForget(memory: Pick<Memory, "isManuallyAdded" | "originProvider">): boolean {
  return memory.isManuallyAdded || memory.originProvider !== "make0";
}

function mayArchiveExisting(
  existing: Pick<Memory, "isManuallyAdded" | "originProvider">,
  incoming: Pick<Memory, "entityType" | "isManuallyAdded" | "originProvider">,
): boolean {
  if (!isProtectedFromForget(existing)) return true;
  if (incoming.entityType === "correction") return true;
  if (incoming.isManuallyAdded) return true;
  return incoming.originProvider !== "make0";
}

async function memoriesContradict(
  incoming: Pick<Memory, "content" | "entityType">,
  existing: Memory,
  pairScorer?: PairScorer,
): Promise<boolean> {
  const topicA = stripPolarityMarkers(incoming.content);
  const topicB = stripPolarityMarkers(existing.content);
  const topicOverlap = lexicalSimilarity(topicA, topicB);

  if (incoming.entityType === "correction" && topicOverlap >= CONTRADICTION_CORRECTION_OVERLAP_MIN) {
    return true;
  }

  const incomingPolarity = getMemoryPolarity(incoming.content);
  const existingPolarity = getMemoryPolarity(existing.content);
  if (incomingPolarity === "neutral" || existingPolarity === "neutral" || incomingPolarity === existingPolarity) {
    return false;
  }

  if (topicOverlap >= CONTRADICTION_TOPIC_OVERLAP_MIN) return true;
  if (topicOverlap >= CONTRADICTION_CROSS_ENCODER_PREFILTER && pairScorer) {
    try {
      const [score] = await pairScorer.score(topicA, [topicB]);
      return (score ?? 0) >= CONTRADICTION_CROSS_ENCODER_MIN;
    } catch {
      return false;
    }
  }
  return false;
}

export type SupersessionResult = {
  /** Older memories to archive (versions kept). */
  archiveIds: string[];
  /** Judge-approved merged text for the incoming memory, when a pair merged. */
  mergedContent?: string;
};

/**
 * Decide which older memories the incoming one replaces. The newest write
 * wins; the caller archives `archiveIds`, so versions stay recoverable.
 *
 * With a BYO key, the LLM pair judge (as in Make0 cloud) sees the
 * closest lexical matches and can merge restated duplicates. Everything else
 * goes through the heuristic: opposite polarity on one topic, or a correction.
 * Without a judge, restated duplicates are kept: the MiniLM cross-encoder
 * scores relevance, not sameness, and rates distinct notes on one topic ~1.0.
 */
export async function resolveSupersession(
  incoming: Memory,
  existing: Memory[],
  options: { pairScorer?: PairScorer; judge?: PairJudge } = {},
): Promise<SupersessionResult> {
  const candidates = existing.filter(
    (candidate) => candidate.id !== incoming.id && !candidate.deletedAt && mayArchiveExisting(candidate, incoming),
  );
  const archiveIds: string[] = [];
  const judged = new Set<string>();
  let mergedContent: string | undefined;

  if (options.judge) {
    const incomingText = memoryDocumentText(incoming);
    const shortlist = candidates
      .map((candidate) => ({ candidate, score: lexicalSimilarity(memoryDocumentText(candidate), incomingText) }))
      .filter((entry) => entry.score >= MEMORY_MERGE_LEXICAL_PREFILTER)
      .sort((a, b) => b.score - a.score)
      .slice(0, MEMORY_PAIR_JUDGE_BUDGET);
    const verdicts = await Promise.all(
      shortlist.map(async ({ candidate }) => ({
        candidate,
        verdict: await options.judge!(candidate.content, incoming.content),
      })),
    );
    for (const { candidate, verdict } of verdicts) {
      if (!verdict) continue;
      judged.add(candidate.id);
      if (verdict.action === "distinct") continue;
      if (verdict.action === "merge" && verdict.mergedContent) mergedContent = verdict.mergedContent;
      archiveIds.push(candidate.id);
    }
  }

  for (const candidate of candidates) {
    if (judged.has(candidate.id)) continue;
    if (await memoriesContradict(incoming, candidate, options.pairScorer)) archiveIds.push(candidate.id);
  }
  return { archiveIds, mergedContent };
}
