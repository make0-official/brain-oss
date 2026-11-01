import os from "node:os";
import type { ImportFile } from "../sources";
import { oneLine, sessionDigest as digestWithLabel, sessionProject } from "./digest";
import {
  cherryStudioReader,
  claudeCodeReader,
  codeBuddyReader,
  qwenReader,
} from "./readers/claude";
import { codexReader, traeReader } from "./readers/codex";
import { clineReader, copilotChatReader, cursorIdeReader, kiloExtensionReader, rooReader } from "./readers/editors";
import {
  aiderReader,
  ampReader,
  antigravityReader,
  codeWhaleReader,
  commandCodeReader,
  continueReader,
  copilotReader,
  cursorCliReader,
  deepSeekReader,
  geminiReader,
  grokReader,
  junieReader,
  kimiReader,
  kiroReader,
  mcodeReader,
  museReader,
  reasonixReader,
  zcodeReader,
} from "./readers/jsonl";
import { gjcReader, kimchiReader, ompReader, openClawReader, piReader, primeReader, senpiReader } from "./readers/pi";
import { crushReader, devinReader, gooseReader, hermesReader, kiloCliReader, opencodeReader, zcodeCliReader, zedReader } from "./readers/sqlite";
import type { ParsedSession } from "./session";
import type { ReaderContext, SessionReader, SessionRef } from "./store";

export { parseClaudeCodeSession } from "./readers/claude";
export { parseCodexSession } from "./readers/codex";
export { parseSince, projectName, projectRoot, redactSecrets } from "./digest";
export type { ParsedSession, SessionCommand } from "./session";

/**
 * Every agent whose sessions can be read from disk. An id can have more than
 * one reader when the agent keeps more than one store (Cursor's CLI
 * transcripts and its IDE database, Kilo's extension and CLI).
 */
export const SESSION_READERS: SessionReader[] = [
  claudeCodeReader,
  codexReader,
  cursorCliReader,
  cursorIdeReader,
  copilotChatReader,
  copilotReader,
  geminiReader,
  antigravityReader,
  opencodeReader,
  clineReader,
  rooReader,
  kiloExtensionReader,
  kiloCliReader,
  continueReader,
  aiderReader,
  ampReader,
  gooseReader,
  crushReader,
  zedReader,
  hermesReader,
  openClawReader,
  piReader,
  ompReader,
  senpiReader,
  gjcReader,
  kimchiReader,
  primeReader,
  qwenReader,
  kimiReader,
  kiroReader,
  junieReader,
  devinReader,
  deepSeekReader,
  codeWhaleReader,
  codeBuddyReader,
  commandCodeReader,
  zcodeReader,
  zcodeCliReader,
  reasonixReader,
  traeReader,
  museReader,
  mcodeReader,
  grokReader,
  cherryStudioReader,
];

/** Agent ids, each once, in registry order. */
export const SESSION_AGENTS: Array<{ id: string; label: string }> = [
  ...new Map(SESSION_READERS.map((reader) => [reader.id, { id: reader.id, label: reader.label }])).values(),
];

const LABELS = new Map(SESSION_AGENTS.map((agent) => [agent.id, agent.label]));

export function agentLabel(id: string): string {
  return LABELS.get(id) ?? id;
}

/** One memory per session, headed by the agent's display name. */
export function sessionDigest(session: ParsedSession, label = agentLabel(session.agent)): string {
  return digestWithLabel(session, label);
}

/** `import --sessions` reads this many days back unless `--since` says otherwise. */
export const DEFAULT_SESSION_WINDOW_DAYS = 30;
/** …and at most this many sessions, newest first, unless `--limit` says otherwise. */
export const DEFAULT_SESSION_LIMIT = 500;

export type SessionImportOptions = {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Skip sessions not active since this time. */
  since?: Date;
  /** At most this many sessions, the most recently active ones. */
  limit?: number;
  /** Agent ids; all of them when unset. */
  agents?: string[];
  /** A store that could not be read. */
  warn?: (message: string) => void;
};

/** Where a scan is: looking through an agent's stores, or reading the sessions that passed the filters. */
export type ScanProgress = { phase: "finding"; agent: string } | { phase: "reading"; agent: string; done: number; total: number };

/**
 * The scan as steps: it pauses after each store it looks through and each
 * session it reads. The sync caller runs straight through; the async one
 * gives the event loop a turn at each pause, so a spinner keeps moving.
 */
function* scan(options: SessionImportOptions, ctx: ReaderContext, progress: (event: ScanProgress) => void): Generator<void, Map<string, Kept>> {
  const wanted = options.agents ? new Set(options.agents) : null;
  const refs: SessionRef[] = [];
  for (const reader of SESSION_READERS) {
    if (wanted && !wanted.has(reader.id)) continue;
    progress({ phase: "finding", agent: reader.id });
    yield;
    try {
      refs.push(...reader.find(ctx));
    } catch (error) {
      ctx.warn(`${reader.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const since = options.since?.getTime();
  let recent = refs.filter((ref) => since == null || ref.mtimeMs >= since).sort((a, b) => a.mtimeMs - b.mtimeMs);
  // Nothing past the limit is read at all, so a huge history costs a directory walk, not a parse.
  if (options.limit != null && options.limit > 0) recent = recent.slice(-options.limit);

  // An agent with two stores can hold one session in both (Cursor's CLI transcript and IDE
  // database); keep the copy that knows its project and has the most turns.
  const best = new Map<string, Kept>();
  const score = (session: ParsedSession) =>
    (session.cwd ? 2_000_000 : session.project ? 1_000_000 : 0) + session.prompts.length * 1000 + session.filesChanged.length + session.commands.length;
  for (const [index, ref] of recent.entries()) {
    progress({ phase: "reading", agent: ref.agent, done: index, total: recent.length });
    if (index % 5 === 0) yield;
    let loaded: ParsedSession | ParsedSession[] | null;
    try {
      loaded = ref.load();
    } catch (error) {
      ctx.warn(`${agentLabel(ref.agent)}: could not read ${ref.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const sessions = Array.isArray(loaded) ? loaded : loaded ? [loaded] : [];
    for (const session of sessions) {
      if (session.prompts.length === 0) continue;
      const key = `${ref.agent}:${session.id}`;
      const current = best.get(key);
      if (!current || score(session) > score(current.session)) best.set(key, { ref, session, many: sessions.length > 1 });
    }
  }
  return best;
}

type Kept = { ref: SessionRef; session: ParsedSession; many: boolean };

function readerContext(options: SessionImportOptions, cleanups: Array<() => void>): ReaderContext {
  return {
    home: options.home ?? os.homedir(),
    env: options.env ?? (options.home ? {} : process.env),
    platform: options.platform ?? process.platform,
    since: options.since?.getTime(),
    defer: (cleanup) => cleanups.push(cleanup),
    warn: options.warn ?? (() => {}),
  };
}

function toImportFiles(best: Map<string, Kept>): ImportFile[] {
  return [...best.values()].map(({ ref, session, many }) => ({
    // A store with many sessions per file (aider's history) names each one.
    path: many ? `${ref.path}#${session.id}` : ref.path,
    name: oneLine(session.title ?? session.prompts[0], 80),
    source: `${ref.agent}-session`,
    folder: sessionProject(session),
    text: digestWithLabel(session, agentLabel(ref.agent)),
  }));
}

/** Sessions with at least one prompt the person typed, as import files whose text is the digest. */
export function collectSessionFiles(options: SessionImportOptions = {}): ImportFile[] {
  const cleanups: Array<() => void> = [];
  try {
    const steps = scan(options, readerContext(options, cleanups), () => {});
    let next = steps.next();
    while (!next.done) next = steps.next();
    return toImportFiles(next.value);
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

/** The same scan, yielding to the event loop as it goes and reporting where it is. */
export async function collectSessionFilesAsync(
  options: SessionImportOptions & { onProgress?: (event: ScanProgress) => void } = {},
): Promise<ImportFile[]> {
  const cleanups: Array<() => void> = [];
  try {
    const steps = scan(options, readerContext(options, cleanups), options.onProgress ?? (() => {}));
    let next = steps.next();
    while (!next.done) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      next = steps.next();
    }
    return toImportFiles(next.value);
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}
