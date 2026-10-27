/** Keep scores at or above max(minScore, top * relativeRatio). Slice only when maxResults is set. */
export function keepRankedByThreshold<T extends { score: number }>(
  scored: T[],
  options: {
    minScore: number;
    relativeRatio: number;
    maxResults?: number;
  },
): T[] {
  if (scored.length === 0) return [];
  const sorted = [...scored].sort((left, right) => right.score - left.score);
  const topScore = sorted[0].score;
  const effectiveMin = Math.max(options.minScore, topScore * options.relativeRatio);
  const kept = sorted.filter((item) => item.score >= effectiveMin);
  if (options.maxResults == null) return kept;
  return kept.slice(0, Math.max(0, options.maxResults));
}
