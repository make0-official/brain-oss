import { cosineSimilarity } from "../embeddings/provider";
import { MEMORY_PAIR_JUDGE_BUDGET, type PairJudge } from "../llm/judge";
import { lexicalSimilarity, tokenize } from "../search/lexical";
import type { Memory } from "../shared/types";

/** A correction replaces the one memory it overlaps most, and only above this word overlap. */
const CORRECTION_OVERLAP_MIN = 0.4;
/** Word overlap of the two contents that earns a pair-judge call. */
const JUDGE_LEXICAL_MIN = 0.4;
/**
 * Embedding cosine that earns a pair-judge call. On all-MiniLM-L6 document
 * vectors, reworded updates of one fact score 0.57 to 0.90 and unrelated
 * memories in one category mostly below 0.5. The judge sorts out the overlap.
 */
const JUDGE_COSINE_MIN = 0.55;
/** A statement needs this many topic words before polarity alone can replace it. */
const POLARITY_TOPIC_MIN_TOKENS = 2;

type MemoryPolarity = "positive" | "negative" | "neutral";

const SUBJECT = "(?:the user|i|we)";
/** "I really dislike", "we still prefer". */
const ADVERB = "(?:(?:really|still|now|also|just|actually|strongly|generally)\\s+)?";

// Cloud patterns are third person ("the user prefers"); MCP agents also write first person.
const MEMORY_NEGATIVE_PATTERNS = [
  new RegExp(`\\b${SUBJECT}\\s+${ADVERB}(?:avoids?|dislikes?|hates?)\\b`, "i"),
  /\b(?:the user|i|we)\s+(?:does not|do not|doesn't|don't)\s+(?:prefer|like|want|use)\b/i,
  /\b(?:the user|i|we)\s+would not\b/i,
  /\bno longer\b/i,
  /\bstopped\b/i,
  /\bnever (?:uses?|prefers?)\b/i,
];

const MEMORY_POSITIVE_PATTERNS = [
  new RegExp(`\\b${SUBJECT}\\s+${ADVERB}(?:prefers?|likes?|loves?|usually|typically|tends? to|always)\\b`, "i"),
  /\b(?:the user|i|we)\s+would rather\b/i,
];

/** Subject, polarity and filler words. What is left of a statement is its topic. */
const POLARITY_TOKENS = new Set(
  tokenize(
    "the user i we my our prefers prefer likes like loves love wants want usually typically tends tend to always " +
      "avoids avoid dislikes dislike hates hate does do not doesn't don't would rather no longer stopped never " +
      "anymore any more now really still also just actually strongly generally",
  ),
);

function getMemoryPolarity(content: string): MemoryPolarity {
  if (MEMORY_NEGATIVE_PATTERNS.some((pattern) => pattern.test(content))) return "negative";
  if (MEMORY_POSITIVE_PATTERNS.some((pattern) => pattern.test(content))) return "positive";
  return "neutral";
}

function topicTokens(content: string): Set<string> {
  return new Set(tokenize(content).filter((token) => !POLARITY_TOKENS.has(token)));
}

function sameTokens(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
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

/**
 * No-LLM rule: the two say the same thing with opposite polarity. Every topic
 * word must match, because one different word is usually a different subject
 * ("tabs in Go" and "tabs in Python", "dark mode" and "light mode").
 */
function oppositePolarityOnSameTopic(incoming: Pick<Memory, "content">, existing: Pick<Memory, "content">): boolean {
  const incomingPolarity = getMemoryPolarity(incoming.content);
  const existingPolarity = getMemoryPolarity(existing.content);
  if (incomingPolarity === "neutral" || existingPolarity === "neutral" || incomingPolarity === existingPolarity) {
    return false;
  }
  const incomingTopic = topicTokens(incoming.content);
  return incomingTopic.size >= POLARITY_TOPIC_MIN_TOKENS && sameTokens(incomingTopic, topicTokens(existing.content));
}

function hasComparableEmbedding(a: Memory, b: Memory): boolean {
  return Boolean(a.embedding?.length && b.embedding?.length && a.embeddingModel === b.embeddingModel);
}

/**
 * Closest memories for the pair judge. Embeddings find reworded updates
 * ("My home city is Pune" and "I'm based in Bangalore now") that share few words.
 */
function shortlistForJudge(incoming: Memory, candidates: Memory[]): Memory[] {
  return candidates
    .map((candidate) => {
      const lexical = lexicalSimilarity(candidate.content, incoming.content);
      const cosine = hasComparableEmbedding(incoming, candidate)
        ? cosineSimilarity(incoming.embedding!, candidate.embedding!)
        : 0;
      return { candidate, lexical, cosine };
    })
    .filter((entry) => entry.lexical >= JUDGE_LEXICAL_MIN || entry.cosine >= JUDGE_COSINE_MIN)
    .sort((a, b) => Math.max(b.lexical, b.cosine) - Math.max(a.lexical, a.cosine))
    .slice(0, MEMORY_PAIR_JUDGE_BUDGET)
    .map((entry) => entry.candidate);
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
 * With a BYO key or local model, the LLM pair judge sees the closest matches
 * by embedding and by shared words, and can merge restated duplicates.
 *
 * Memories the judge did not rule on go through two narrow rules: the same
 * statement with opposite polarity, and a correction, which replaces only its
 * single closest match. Without a judge, a changed value ("Pune", then
 * "Bangalore") and restated duplicates are kept rather than guessed at.
 */
export async function resolveSupersession(
  incoming: Memory,
  existing: Memory[],
  options: { judge?: PairJudge } = {},
): Promise<SupersessionResult> {
  const candidates = existing.filter(
    (candidate) => candidate.id !== incoming.id && !candidate.deletedAt && mayArchiveExisting(candidate, incoming),
  );
  const archiveIds: string[] = [];
  const judged = new Set<string>();
  let mergedContent: string | undefined;

  if (options.judge) {
    const verdicts = await Promise.all(
      shortlistForJudge(incoming, candidates).map(async (candidate) => ({
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

  const unjudged = candidates.filter((candidate) => !judged.has(candidate.id));
  for (const candidate of unjudged) {
    if (oppositePolarityOnSameTopic(incoming, candidate)) archiveIds.push(candidate.id);
  }

  // A correction names one thing to fix. Skip it when something was already replaced.
  if (incoming.entityType === "correction" && archiveIds.length === 0) {
    let best: { id: string; overlap: number } | undefined;
    for (const candidate of unjudged) {
      const overlap = lexicalSimilarity(incoming.content, candidate.content);
      if (overlap >= CORRECTION_OVERLAP_MIN && (!best || overlap > best.overlap)) best = { id: candidate.id, overlap };
    }
    if (best) archiveIds.push(best.id);
  }
  return { archiveIds, mergedContent };
}
