function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const ORDINAL_TOKEN = /^(\d+)(st|nd|rd|th)$/;

function stripOrdinalSuffix(token: string): string {
  const match = token.match(ORDINAL_TOKEN);
  return match ? match[1] : token;
}

function keepToken(token: string): boolean {
  if (token.length >= 2) return true;
  return /^\d$/.test(token);
}

function normalizeToken(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenize(value: string): string[] {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map(stripOrdinalSuffix)
    // Keep 2+ char terms (AI, JS, UK) and single-digit days/months (5 March).
    .filter(keepToken)
    .map(normalizeToken);
}

export function lexicalSimilarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }

  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Fraction of distinct query tokens that appear in the document (better for long snippets). */
export function queryTermCoverage(query: string, document: string): number {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return 0;
  const documentTokens = new Set(tokenize(document));
  let hits = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.length;
}

const MONTH_ENTRIES: Array<{ number: number; names: string[] }> = [
  { number: 1, names: ["january", "jan"] },
  { number: 2, names: ["february", "feb"] },
  { number: 3, names: ["march", "mar"] },
  { number: 4, names: ["april", "apr"] },
  { number: 5, names: ["may"] },
  { number: 6, names: ["june", "jun"] },
  { number: 7, names: ["july", "jul"] },
  { number: 8, names: ["august", "aug"] },
  { number: 9, names: ["september", "sep", "sept"] },
  { number: 10, names: ["october", "oct"] },
  { number: 11, names: ["november", "nov"] },
  { number: 12, names: ["december", "dec"] },
];

const MONTH_NAME_TO_NUMBER = new Map<string, number>();
const MONTH_NUMBER_TO_NAMES = new Map<number, string[]>();
for (const entry of MONTH_ENTRIES) {
  MONTH_NUMBER_TO_NAMES.set(entry.number, entry.names);
  for (const name of entry.names) {
    MONTH_NAME_TO_NUMBER.set(name, entry.number);
  }
}

const MONTH_NAME_PATTERN = MONTH_ENTRIES.flatMap((entry) => entry.names).join("|");

export type MemoryDate = {
  year: number;
  month?: number;
  day?: number;
  iso?: string;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isPlausibleYear(year: number): boolean {
  return year >= 1900 && year <= 2100;
}

function isPlausibleMonth(month: number): boolean {
  return month >= 1 && month <= 12;
}

function isPlausibleDay(day: number): boolean {
  return day >= 1 && day <= 31;
}

function toIso(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pushDate(
  dates: MemoryDate[],
  seen: Set<string>,
  year: number,
  month?: number,
  day?: number,
): void {
  if (!isPlausibleYear(year)) return;
  if (month != null && !isPlausibleMonth(month)) return;
  if (day != null && !isPlausibleDay(day)) return;
  const iso = month != null && day != null ? toIso(year, month, day) : undefined;
  const key = iso ?? (month != null ? `${year}-${pad2(month)}` : String(year));
  if (seen.has(key)) return;
  if (
    day == null &&
    month != null &&
    dates.some(
      (date) => date.year === year && date.month === month && date.day != null,
    )
  ) {
    return;
  }
  seen.add(key);
  dates.push({ year, month, day, iso });
}

function resolveNumericDate(
  left: number,
  right: number,
): { month: number; day: number } | null {
  if (!isPlausibleDay(left) && !isPlausibleMonth(left)) return null;
  if (!isPlausibleDay(right) && !isPlausibleMonth(right)) return null;
  if (left > 12 && isPlausibleMonth(right)) {
    return { day: left, month: right };
  }
  if (right > 12 && isPlausibleMonth(left)) {
    return { month: left, day: right };
  }
  if (isPlausibleMonth(left) && isPlausibleDay(right)) {
    return { month: left, day: right };
  }
  if (isPlausibleMonth(right) && isPlausibleDay(left)) {
    return { day: left, month: right };
  }
  return null;
}

/** Calendar dates mentioned in text (ISO, prose, numeric, year+month). */
export function parseMemoryDates(text: string): MemoryDate[] {
  const dates: MemoryDate[] = [];
  const seen = new Set<string>();
  const value = normalizeText(text);
  if (!value) return dates;

  const isoFull = /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/g;
  for (const match of value.matchAll(isoFull)) {
    pushDate(dates, seen, Number(match[1]), Number(match[2]), Number(match[3]));
  }

  const isoYearMonth = /\b(\d{4})[/-](\d{1,2})(?![/-]\d)/g;
  for (const match of value.matchAll(isoYearMonth)) {
    pushDate(dates, seen, Number(match[1]), Number(match[2]));
  }

  const monthDayYear = new RegExp(
    `\\b(${MONTH_NAME_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[\\s,]+(\\d{4}))?\\b`,
    "gi",
  );
  for (const match of value.matchAll(monthDayYear)) {
    const month = MONTH_NAME_TO_NUMBER.get(match[1].toLowerCase());
    const day = Number(match[2]);
    if (match[3]) {
      pushDate(dates, seen, Number(match[3]), month, day);
    } else if (month != null) {
      // Month+day without year is not a comparable calendar date.
    }
  }

  const dayMonthYear = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME_PATTERN})(?:[\\s,]+(\\d{4}))?\\b`,
    "gi",
  );
  for (const match of value.matchAll(dayMonthYear)) {
    const month = MONTH_NAME_TO_NUMBER.get(match[2].toLowerCase());
    if (match[3]) {
      pushDate(dates, seen, Number(match[3]), month, Number(match[1]));
    }
  }

  const monthYear = new RegExp(`\\b(${MONTH_NAME_PATTERN})\\s+(\\d{4})\\b`, "gi");
  for (const match of value.matchAll(monthYear)) {
    const month = MONTH_NAME_TO_NUMBER.get(match[1].toLowerCase());
    pushDate(dates, seen, Number(match[2]), month);
  }

  const numeric = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g;
  for (const match of value.matchAll(numeric)) {
    const resolved = resolveNumericDate(Number(match[1]), Number(match[2]));
    if (resolved) {
      pushDate(dates, seen, Number(match[3]), resolved.month, resolved.day);
    }
  }

  return dates;
}

function dateAliasTokens(date: MemoryDate): string[] {
  const aliases: string[] = [String(date.year)];
  if (date.month != null) {
    aliases.push(String(date.month), pad2(date.month));
    aliases.push(...(MONTH_NUMBER_TO_NAMES.get(date.month) ?? []));
  }
  if (date.day != null) {
    aliases.push(String(date.day), pad2(date.day));
  }
  return aliases;
}

/**
 * Add month-name ↔ number aliases so ISO `2024-03-15` overlaps `March 15, 2024`.
 * Month numbers become names only from parsed dates (not every 1–12 token) so
 * a day like `5` is not treated as May.
 */
export function expandDateTokens(tokens: string[], sourceText?: string): string[] {
  const extra: string[] = [];
  const hasYear = tokens.some((token) => /^\d{4}$/.test(token) && isPlausibleYear(Number(token)));

  for (const token of tokens) {
    const month = MONTH_NAME_TO_NUMBER.get(token);
    if (month == null) continue;
    extra.push(String(month), pad2(month));
  }

  if (hasYear) {
    for (const token of tokens) {
      if (!/^\d{1,2}$/.test(token) || token.length !== 2) continue;
      const month = Number(token);
      if (!isPlausibleMonth(month)) continue;
      extra.push(...(MONTH_NUMBER_TO_NAMES.get(month) ?? []));
    }
  }

  if (sourceText) {
    for (const date of parseMemoryDates(sourceText)) {
      extra.push(...dateAliasTokens(date));
    }
  }

  return extra.length === 0 ? tokens : [...tokens, ...extra];
}

export function isTemporalQuery(query: string): boolean {
  return (
    /\b(?:when|what year|what date|which year|how long ago|last year|last month|yesterday|years ago|months ago|weeks ago|days ago|what happened)\b/i.test(
      query,
    ) || parseMemoryDates(query).some((date) => date.month != null || date.year != null)
  );
}

export function memoryDateMatchScore(query: string, document: string): number {
  const queryDates = parseMemoryDates(query);
  const memoryDates = parseMemoryDates(document);
  if (memoryDates.length === 0) return 0;

  let best = 0;
  const queryHasMonth = queryDates.some((date) => date.month != null);
  if (queryHasMonth) {
    for (const queryDate of queryDates) {
      if (queryDate.month == null) continue;
      for (const memoryDate of memoryDates) {
        if (queryDate.year !== memoryDate.year) continue;
        if (memoryDate.month == null || queryDate.month !== memoryDate.month) continue;
        if (
          queryDate.day != null &&
          memoryDate.day != null &&
          queryDate.day === memoryDate.day
        ) {
          best = Math.max(best, 1);
        } else {
          best = Math.max(best, 0.7);
        }
      }
    }
    return best;
  }

  if (!isTemporalQuery(query)) return 0;
  if (memoryDates.some((date) => date.iso)) return 0.55;
  if (memoryDates.some((date) => date.month != null)) return 0.4;
  return 0.2;
}

/** Lucene default; saturates faster than 1.5 so one mention in a short memory is enough. */
const BM25_K1 = 1.2;
/** BEIR short/mixed default; less length-norm than TREC 0.75 on sentence-length facts. */
const BM25_B = 0.4;

/**
 * Query-only function words. Do not include `may` (month). `tokenize` still keeps
 * 2-char tech tokens (ai, js); those are not in this list.
 */
const BM25_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "did",
  "do",
  "does",
  "for",
  "happened",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "who",
]);

function phraseTerms(tokens: string[]): string[] {
  const phrases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (BM25_QUERY_STOPWORDS.has(left) || BM25_QUERY_STOPWORDS.has(right)) continue;
    phrases.push(`${left}_${right}`);
  }
  return phrases;
}

function bm25QueryTerms(query: string): string[] {
  const tokens = tokenize(query);
  const expanded = expandDateTokens(tokens, query);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of [...expanded, ...phraseTerms(tokens)]) {
    if (BM25_QUERY_STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

export type Bm25DocumentScore = {
  id: string;
  score: number;
  normalized: number;
};

function tokenTermFrequency(
  text: string,
): { tf: Map<string, number>; length: number } {
  const tokens = tokenize(text);
  const expanded = [...expandDateTokens(tokens, text), ...phraseTerms(tokens)];
  const tf = new Map<string, number>();
  for (const token of expanded) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  return { tf, length: Math.max(tokens.length, 1) };
}

/** Okapi BM25 over a memory/document collection. `normalized` is 0–1 vs the top hit. */
export function scoreDocumentsBm25(
  query: string,
  documents: Array<{ id: string; text: string }>,
): Bm25DocumentScore[] {
  const queryTerms = bm25QueryTerms(query);
  if (queryTerms.length === 0 || documents.length === 0) return [];

  const tokenized = documents.map((doc) => {
    const { tf, length } = tokenTermFrequency(doc.text);
    return { id: doc.id, tf, length };
  });

  const n = tokenized.length;
  const avgdl = tokenized.reduce((sum, doc) => sum + doc.length, 0) / n;
  const df = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    let count = 0;
    for (const doc of tokenized) {
      if (doc.tf.has(term)) count += 1;
    }
    df.set(term, count);
  }

  const idf = (term: string): number => {
    const documentFrequency = df.get(term) || 0;
    if (documentFrequency === 0) return 0;
    return Math.log(1 + (n - documentFrequency + 0.5) / (documentFrequency + 0.5));
  };

  const scored = tokenized.map((doc) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.tf.get(term) || 0;
      if (tf === 0) continue;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl));
      score += idf(term) * ((tf * (BM25_K1 + 1)) / denom);
    }
    return { id: doc.id, score };
  });

  const maxScore = Math.max(0, ...scored.map((item) => item.score));
  return scored
    .map((item) => ({
      ...item,
      normalized: maxScore > 0 ? item.score / maxScore : 0,
    }))
    .sort((left, right) => right.score - left.score);
}
