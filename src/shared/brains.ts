import {
  BRAIN_DESCRIPTION_MAX_LENGTH,
  BRAIN_EMOJI_MAX_LENGTH,
  BRAIN_NAME_MAX_LENGTH,
  PERSONAL_BRAIN_ID,
  type UserBrain,
} from "./types";

type BrainLookup = {
  getBrain(id: string): UserBrain | undefined;
  listBrains(): UserBrain[];
};

/** Collapse whitespace and cap the name. Empty when the input is blank. */
export function normalizeBrainName(value: string | null | undefined): string {
  if (value == null) return "";
  return value.replace(/\s+/g, " ").trim().slice(0, BRAIN_NAME_MAX_LENGTH);
}

/** Empty input clears the description. Extra whitespace is collapsed. */
export function normalizeBrainDescription(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, BRAIN_DESCRIPTION_MAX_LENGTH);
}

/** Empty input clears the emoji. */
export function normalizeBrainEmoji(value: string | null | undefined): string | null {
  if (value == null) return null;
  const emoji = value.trim();
  if (!emoji) return null;
  return emoji.slice(0, BRAIN_EMOJI_MAX_LENGTH);
}

/** Id wins. A unique name matches too. */
export function findBrain(store: BrainLookup, ref: string): UserBrain | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const byId = store.getBrain(trimmed);
  if (byId) return byId;
  const needle = trimmed.toLowerCase();
  const matches = store.listBrains().filter((brain) => brain.name.toLowerCase() === needle);
  return matches.length === 1 ? matches[0] : undefined;
}

export function isPersonalBrain(id: string): boolean {
  return id === PERSONAL_BRAIN_ID;
}
