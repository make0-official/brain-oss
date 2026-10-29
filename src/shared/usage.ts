/** Usage counters attribute viewer edits to this client id. */
export const USER_CLIENT_ID = "user";

/** Rough token count (about 4 characters per token). */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function sumTokens(texts: Array<string | null | undefined>): number {
  return texts.reduce((total, text) => total + estimateTokens(text), 0);
}
