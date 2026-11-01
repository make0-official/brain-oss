import path from "node:path";
import { type ParsedSession, SessionBuilder, asRecord } from "../session";
import {
  type ReaderContext,
  type SessionReader,
  type SessionRef,
  columns,
  fileRefs,
  hasTable,
  listFiles,
  openSqlite,
  parseJsonLines,
  readJsonLines,
  subdirs,
  zstdDecompress,
} from "../store";

/**
 * pi's session JSONL: a `session` header (id, cwd, title), then `message`
 * lines whose `message` is `{role, content}`; tool results are their own
 * `toolResult` role. omp, Senpi, gajae-code, Kimchi, Prime and OpenClaw
 * descend from pi and write the same lines.
 */
export function parsePiRecords(agent: string, fallbackId: string, records: Array<Record<string, unknown>>): ParsedSession {
  const builder = new SessionBuilder(agent, fallbackId);
  for (const record of records) {
    builder.time(record.timestamp);
    if (record.type === "session") {
      builder.id(record.id).setCwd(record.cwd).title(record.title);
      continue;
    }
    if (record.type !== "message") continue;
    const message = asRecord(record.message);
    const role = String(message.role ?? "");
    if (role === "toolResult" || role === "tool") {
      builder.message("tool", message.content, {
        toolCallId: message.toolCallId ?? message.tool_call_id,
        isError: message.isError,
        exitCode: typeof asRecord(message.details).exitCode === "number" ? (asRecord(message.details).exitCode as number) : null,
      });
    } else {
      builder.message(role, message.content, { toolCalls: message.toolCalls });
    }
  }
  return builder.build();
}

function piFile(agent: string) {
  return (file: string) => parsePiRecords(agent, path.basename(file, ".jsonl").replace(/^[\dT:.Z-]+_/, ""), readJsonLines(file));
}

/** `<root>/<encoded-project>/<session>.jsonl`; deeper folders are sub-agent passes and skipped. */
function projectSessions(root: string): string[] {
  return [...listFiles(root, (name) => name.endsWith(".jsonl")), ...subdirs(root).flatMap((dir) => listFiles(dir, (name) => name.endsWith(".jsonl")))];
}

function piFamily(id: string, label: string, roots: (ctx: ReaderContext) => string[]): SessionReader {
  return { id, label, find: (ctx) => fileRefs(id, roots(ctx).flatMap(projectSessions), piFile(id)) };
}

export const piReader = piFamily("pi", "pi", (ctx) => [path.join(ctx.env.PI_CODING_AGENT_DIR || path.join(ctx.home, ".pi", "agent"), "sessions")]);

export const ompReader = piFamily("omp", "omp", (ctx) => [
  path.join(ctx.home, ".omp", "agent", "sessions"),
  ...subdirs(path.join(ctx.home, ".omp", "profiles")).map((profile) => path.join(profile, "agent", "sessions")),
]);

export const senpiReader = piFamily("senpi", "Senpi", (ctx) => [
  path.join(ctx.env.SENPI_CODING_AGENT_DIR || path.join(ctx.home, ".senpi", "agent"), "sessions"),
]);

export const gjcReader = piFamily("gjc", "gajae-code", (ctx) => [
  path.join(ctx.env.GJC_CODING_AGENT_DIR || path.join(ctx.home, ".gjc", "agent"), "sessions"),
]);

export const kimchiReader = piFamily("kimchi", "Kimchi", (ctx) => [path.join(ctx.home, ".config", "kimchi", "harness", "sessions")]);

export const primeReader: SessionReader = {
  id: "prime",
  label: "prime-agent",
  find: (ctx) => {
    const agentDir = ctx.env.PRIME_AGENT_CODING_AGENT_DIR || path.join(ctx.home, ".prime", "agent");
    const root = ctx.env.PRIME_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
    return fileRefs("prime", listFiles(root, (name) => name.endsWith(".jsonl")), piFile("prime"));
  },
};

/** OpenClaw's per-agent SQLite store (2026.8+): pi lines in `transcript_events`, compressed or not. */
function openClawDatabaseRefs(ctx: ReaderContext, file: string): SessionRef[] {
  const db = openSqlite(file, ctx);
  if (!db || !hasTable(db, "transcript_events")) return [];
  const hasZstd = columns(db, "transcript_events").has("event_zstd");
  const sessions = db
    .prepare("select session_id as id, max(created_at) as updated from transcript_events group by session_id")
    .all() as Array<{ id: string; updated: number }>;
  const events = db.prepare(
    `select event_json${hasZstd ? ", event_zstd" : ""} from transcript_events where session_id = ? order by seq`,
  );
  return sessions.map((session) => ({
    agent: "openclaw",
    path: `${file}#${session.id}`,
    mtimeMs: Number(session.updated) || 0,
    load: () => {
      const lines: string[] = [];
      for (const row of events.all(session.id) as Array<{ event_json: string | null; event_zstd?: Buffer | null }>) {
        if (row.event_json) lines.push(row.event_json);
        else if (row.event_zstd) lines.push(zstdDecompress(row.event_zstd)?.toString("utf8") ?? "");
      }
      const parsed = parsePiRecords("openclaw", session.id, parseJsonLines(lines.join("\n")));
      if (!parsed.cwd) parsed.project = `openclaw-${path.basename(path.dirname(path.dirname(file)))}`;
      return parsed;
    },
  }));
}

export const openClawReader: SessionReader = {
  id: "openclaw",
  label: "OpenClaw",
  find: (ctx) => {
    const agents = path.join(ctx.env.OPENCLAW_STATE_DIR || path.join(ctx.home, ".openclaw"), "agents");
    const refs: SessionRef[] = [];
    for (const agentDir of subdirs(agents)) {
      refs.push(...openClawDatabaseRefs(ctx, path.join(agentDir, "agent", "openclaw-agent.sqlite")));
      // Before 2026.8: one pi transcript per session. Checkpoints and archives are not sessions.
      const legacy = listFiles(path.join(agentDir, "sessions"), (name) => /^[^.]+\.jsonl$/.test(name));
      const migrated = new Set(refs.map((ref) => ref.path.split("#").pop()));
      refs.push(...fileRefs("openclaw", legacy.filter((file) => !migrated.has(path.basename(file, ".jsonl"))), piFile("openclaw")));
    }
    return refs;
  },
};

