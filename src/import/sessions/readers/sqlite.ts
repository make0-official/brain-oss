import path from "node:path";
import { type ParsedSession, SessionBuilder, asArray, asRecord, asString, parseMaybeJson, textOf, toIso } from "../session";
import {
  type ReaderContext,
  type SessionReader,
  type SessionRef,
  columns,
  exists,
  fileRefs,
  hasTable,
  listFiles,
  openSqlite,
  readJson,
  subdirs,
  xdgDataDir,
  zstdDecompress,
} from "../store";
import { gooseMessage, gooseRoots, parseGooseJsonl } from "./jsonl";

type Row = Record<string, unknown>;

function json(value: unknown): Record<string, unknown> {
  return asRecord(parseMaybeJson(typeof value === "string" ? value : value instanceof Buffer ? value.toString("utf8") : value));
}

function epochMs(value: unknown): number {
  const iso = toIso(value);
  return iso ? Date.parse(iso) : 0;
}

/** An opencode tool part: 1.x keeps the name under `tool`, 2.0 under `name`. */
function opencodeTool(builder: SessionBuilder, part: Record<string, unknown>): void {
  const state = asRecord(part.state);
  const id = asString(part.callID) ?? asString(part.id);
  builder.tool(String(part.tool ?? part.name ?? ""), state.input, id);
  const metadata = asRecord(state.metadata);
  builder.result(id, {
    error: state.status === "error",
    text: textOf(state.output ?? state.content ?? state.error),
    exitCode: typeof metadata.exit === "number" ? metadata.exit : null,
  });
}

/** opencode's store (1.x `session`/`message`/`part`, 2.0 `session_v2`/`session_message`); Kilo CLI and ZCode CLI share it. */
function opencodeRefs(agent: string, ctx: ReaderContext, file: string): SessionRef[] {
  const db = openSqlite(file, ctx);
  if (!db) return [];
  const v2 = hasTable(db, "session_v2") && hasTable(db, "session_message");
  const v1 = hasTable(db, "session") && hasTable(db, "message") && hasTable(db, "part");
  if (!v1 && !v2) return [];
  const sessions = new Map<string, Row>();
  const pick = (table: string) => {
    const cols = columns(db, table);
    const select = ["id", "directory", "time_created", "time_updated", cols.has("title") ? "title" : "null as title", cols.has("parent_id") ? "parent_id" : "null as parent_id"];
    for (const row of db.prepare(`select ${select.join(", ")} from ${table}`).all() as Row[]) sessions.set(String(row.id), { ...row, table });
  };
  if (v1) pick("session");
  if (v2) pick("session_v2");
  const v2Turns = v2 ? db.prepare("select type, data, time_created from session_message where session_id = ? order by seq, time_created") : null;
  const v1Messages = v1 ? db.prepare("select id, data, time_created from message where session_id = ? order by time_created, id") : null;
  const v1Parts = v1 ? db.prepare("select data from part where message_id = ? order by id") : null;

  return [...sessions.values()]
    .filter((session) => !session.parent_id)
    .map((session) => ({
      agent,
      path: `${file}#${session.id}`,
      mtimeMs: epochMs(session.time_updated ?? session.time_created),
      load: () => {
        const builder = new SessionBuilder(agent, String(session.id));
        builder.setCwd(session.directory).title(session.title).time(session.time_created).time(session.time_updated);
        const turns = v2Turns ? (v2Turns.all(session.id) as Row[]) : [];
        if (turns.length) {
          for (const turn of turns) {
            const data = json(turn.data);
            builder.time(turn.time_created);
            if (turn.type === "user") builder.prompt(asString(data.text) ?? textOf(data.content));
            if (turn.type !== "assistant") continue;
            for (const part of asArray(data.content).map(asRecord)) {
              if (part.type === "text") builder.reply(part.text);
              if (part.type === "tool") opencodeTool(builder, part);
            }
          }
        } else if (v1Messages && v1Parts) {
          for (const message of v1Messages.all(session.id) as Row[]) {
            const data = json(message.data);
            builder.time(asRecord(data.time).created ?? message.time_created);
            if (data.summary) continue;
            const text: string[] = [];
            for (const partRow of v1Parts.all(message.id) as Row[]) {
              const part = json(partRow.data);
              if (part.type === "text" && !part.synthetic && !part.ignored) text.push(String(part.text ?? ""));
              if (part.type === "tool") opencodeTool(builder, part);
            }
            if (data.role === "user") builder.prompt(text.join("\n"));
            else if (data.role === "assistant") builder.reply(text.join("\n"));
          }
        }
        return builder.build();
      },
    }));
}

export const opencodeReader: SessionReader = {
  id: "opencode",
  label: "opencode",
  find: (ctx) => {
    const dir = xdgDataDir(ctx, "opencode");
    const db = ctx.env.OPENCODE_DB ? path.resolve(dir, ctx.env.OPENCODE_DB) : path.join(dir, "opencode.db");
    const fallback = path.join(ctx.home, ".local", "share", "opencode", "opencode.db");
    return opencodeRefs("opencode", ctx, exists(db) ? db : fallback);
  },
};

export const kiloCliReader: SessionReader = {
  id: "kilocode",
  label: "Kilo Code",
  find: (ctx) => opencodeRefs("kilocode", ctx, path.join(xdgDataDir(ctx, "kilo"), "kilo.db")),
};

export const zcodeCliReader: SessionReader = {
  id: "zcode",
  label: "ZCode",
  find: (ctx) => opencodeRefs("zcode", ctx, path.join(ctx.home, ".zcode", "cli", "db", "db.sqlite")),
};

/** Crush keeps one store per project, listed in `projects.json`. */
function crushRefs(ctx: ReaderContext, project: string, file: string): SessionRef[] {
  const db = openSqlite(file, ctx);
  if (!db || !hasTable(db, "sessions") || !hasTable(db, "messages")) return [];
  const messages = db.prepare("select role, parts, created_at from messages where session_id = ? order by created_at, rowid");
  const sessions = db.prepare("select id, title, created_at, updated_at, parent_session_id from sessions").all() as Row[];
  return sessions
    .filter((session) => !session.parent_session_id)
    .map((session) => ({
      agent: "crush",
      path: `${file}#${session.id}`,
      mtimeMs: epochMs(session.updated_at),
      load: () => {
        const builder = new SessionBuilder("crush", String(session.id));
        builder.setCwd(project).title(session.title).time(session.created_at).time(session.updated_at);
        for (const message of messages.all(session.id) as Row[]) {
          builder.time(message.created_at);
          const text: string[] = [];
          for (const part of asArray(parseMaybeJson(message.parts)).map(asRecord)) {
            const data = asRecord(part.data);
            if (part.type === "text") text.push(String(data.text ?? ""));
            if (part.type === "tool_call") builder.tool(String(data.name ?? ""), data.input, asString(data.id));
            if (part.type === "tool_result") {
              builder.result(asString(data.tool_call_id), { error: Boolean(data.is_error), text: String(data.content ?? "").replace(/<cwd>[\s\S]*?<\/cwd>/g, "") });
            }
          }
          if (message.role === "user") builder.prompt(text.join("\n"));
          else if (message.role === "assistant") builder.reply(text.join("\n"));
        }
        return builder.build();
      },
    }));
}

export const crushReader: SessionReader = {
  id: "crush",
  label: "Crush",
  find: (ctx) => {
    const registry = asRecord(readJson(path.join(xdgDataDir(ctx, "crush"), "projects.json")));
    return asArray(registry.projects)
      .map(asRecord)
      .flatMap((entry) => {
        const project = asString(entry.path);
        if (!project) return [];
        const dataDir = asString(entry.data_dir) ?? path.join(project, ".crush");
        return crushRefs(ctx, project, path.resolve(project, dataDir, "crush.db"));
      });
  },
};

function gooseDatabaseRefs(ctx: ReaderContext, file: string): SessionRef[] {
  const db = openSqlite(file, ctx);
  if (!db || !hasTable(db, "sessions") || !hasTable(db, "messages")) return [];
  const messages = db.prepare("select role, content_json, created_timestamp from messages where session_id = ? order by id");
  const sessions = db.prepare("select * from sessions").all() as Row[];
  return sessions
    .filter((session) => !session.session_type || session.session_type === "user")
    .map((session) => ({
      agent: "goose",
      path: `${file}#${session.id}`,
      mtimeMs: epochMs(session.updated_at ?? session.created_at),
      load: () => {
        const builder = new SessionBuilder("goose", String(session.id));
        builder.setCwd(session.working_dir).title(session.name || session.description).time(session.created_at).time(session.updated_at);
        for (const message of messages.all(session.id) as Row[]) {
          builder.time(message.created_timestamp);
          gooseMessage(builder, String(message.role), parseMaybeJson(message.content_json));
        }
        return builder.build();
      },
    }));
}

export const gooseReader: SessionReader = {
  id: "goose",
  label: "Goose",
  find: (ctx) => {
    const refs: SessionRef[] = [];
    const migrated = new Set<string>();
    for (const root of gooseRoots(ctx)) {
      const dbRefs = gooseDatabaseRefs(ctx, path.join(root, "sessions.db"));
      for (const ref of dbRefs) migrated.add(ref.path.split("#").pop()!);
      refs.push(...dbRefs);
    }
    // Pre-1.10 JSONL files stay on disk after the migration; read only the ones it did not take.
    for (const root of gooseRoots(ctx)) {
      const legacy = listFiles(root, (name) => name.endsWith(".jsonl")).filter((file) => !migrated.has(path.basename(file, ".jsonl")));
      refs.push(...fileRefs("goose", legacy, parseGooseJsonl));
    }
    return refs;
  },
};

/** Hermes: a flat OpenAI-style `messages` table grouped by `session_id`. */
function hermesRefs(ctx: ReaderContext, file: string, profile: string | null): SessionRef[] {
  const db = openSqlite(file, ctx);
  if (!db || !hasTable(db, "messages")) return [];
  const cols = columns(db, "messages");
  const live = cols.has("active") ? (cols.has("compacted") ? "and active = 1 and coalesce(compacted, 0) = 0" : "and active = 1") : "";
  const messages = db.prepare(
    `select role, content, tool_call_id, tool_calls, timestamp from messages where session_id = ? ${live} order by id`,
  );
  const info = hasTable(db, "sessions") ? columns(db, "sessions") : new Set<string>();
  const sessionRow = info.size
    ? db.prepare(`select ${["cwd", "title"].map((col) => (info.has(col) ? col : `null as ${col}`)).join(", ")} from sessions where id = ?`)
    : null;
  const sessions = db.prepare("select session_id as id, max(timestamp) as updated from messages group by session_id").all() as Row[];
  return sessions.map((session) => ({
    agent: "hermes",
    path: `${file}#${session.id}`,
    mtimeMs: epochMs(session.updated),
    load: () => {
      const builder = new SessionBuilder("hermes", String(session.id));
      const row = (sessionRow?.get(session.id) as Row | undefined) ?? {};
      builder.setCwd(row.cwd).title(row.title);
      if (!row.cwd && profile) builder.project(profile);
      for (const message of messages.all(session.id) as Row[]) {
        builder.time(message.timestamp);
        const content = typeof message.content === "string" && message.content.startsWith("\u0000json:") ? parseMaybeJson(message.content.slice(6)) : message.content;
        if (typeof content === "string" && /^\[CONTEXT (?:COMPACTION|SUMMARY)/.test(content)) continue;
        const result = json(content);
        builder.message(message.role, content, {
          toolCalls: parseMaybeJson(message.tool_calls),
          toolCallId: message.tool_call_id,
          exitCode: typeof result.exit_code === "number" ? result.exit_code : null,
        });
      }
      return builder.build();
    },
  }));
}

export const hermesReader: SessionReader = {
  id: "hermes",
  label: "Hermes",
  find: (ctx) => {
    const home = ctx.env.HERMES_HOME || path.join(ctx.home, ".hermes");
    return [
      ...hermesRefs(ctx, path.join(home, "state.db"), null),
      ...subdirs(path.join(home, "profiles")).flatMap((profile) => hermesRefs(ctx, path.join(profile, "state.db"), path.basename(profile))),
    ];
  },
};

/** Devin CLI: walk the live chain back from `main_chain_id`, one copy per `message_id`. */
function devinRefs(ctx: ReaderContext, file: string): SessionRef[] {
  const db = openSqlite(file, ctx);
  if (!db || !hasTable(db, "sessions") || !hasTable(db, "message_nodes")) return [];
  const nodes = db.prepare("select node_id, parent_node_id, chat_message, created_at, metadata from message_nodes where session_id = ?");
  const sessions = db.prepare("select * from sessions where coalesce(hidden, 0) = 0").all() as Row[];
  return sessions.map((session) => ({
    agent: "devin",
    path: `${file}#${session.id}`,
    mtimeMs: epochMs(session.last_activity_at ?? session.created_at),
    load: () => {
      const builder = new SessionBuilder("devin", String(session.id));
      builder.setCwd(session.working_directory).title(session.title).time(session.created_at).time(session.last_activity_at);
      const byId = new Map((nodes.all(session.id) as Row[]).map((node) => [Number(node.node_id), node]));
      const chain: Row[] = [];
      const seen = new Set<string>();
      for (let node = byId.get(Number(session.main_chain_id)); node; node = byId.get(Number(node.parent_node_id))) {
        const message = json(node.chat_message);
        const key = String(message.message_id ?? node.node_id);
        if (seen.has(key)) continue;
        seen.add(key);
        chain.unshift({ ...node, message });
        if (chain.length > 100_000) break;
      }
      for (const node of chain) {
        const message = asRecord(node.message);
        if (json(node.metadata).is_system_prefix || message.role === "system") continue;
        builder.time(node.created_at);
        const exit = asRecord(asRecord(asRecord(asRecord(message.metadata).extensions)["chisel/terminal_output"]).exit).exit_code;
        builder.message(message.role, message.content, {
          toolCalls: message.tool_calls,
          toolCallId: message.tool_call_id,
          exitCode: typeof exit === "number" ? exit : null,
        });
      }
      return builder.build();
    },
  }));
}

export const devinReader: SessionReader = {
  id: "devin",
  label: "Devin CLI",
  find: (ctx) => {
    const dir = ctx.platform === "win32" && ctx.env.LOCALAPPDATA ? path.join(ctx.env.LOCALAPPDATA, "devin", "cli") : path.join(xdgDataDir(ctx, "devin"), "cli");
    const db = ["sessions.db", "cli_sessions.db"].map((name) => path.join(dir, name)).find(exists);
    return db ? devinRefs(ctx, db) : [];
  },
};

/** One Zed thread document: current `{User}`/`{Agent}` messages or the legacy `role`/`segments` shape. */
export function parseZedThread(id: string, doc: Record<string, unknown>, folder: string | null): ParsedSession {
  const builder = new SessionBuilder("zed", id);
  builder.title(doc.title ?? doc.summary).time(doc.updated_at).setCwd(folder);
  for (const entry of asArray(doc.messages)) {
    const message = asRecord(entry);
    if (message.role) {
      const text = asArray(message.segments)
        .map((segment) => (asRecord(segment).type === "text" ? String(asRecord(segment).text ?? "") : ""))
        .join("\n");
      if (message.role === "user") builder.prompt(text);
      else if (message.role === "assistant") builder.reply(text);
      continue;
    }
    const user = asRecord(message.User);
    const agent = asRecord(message.Agent);
    const blocks = asArray((Object.keys(user).length ? user : agent).content).map(asRecord);
    const text = blocks
      .map((block) => (typeof block.Text === "string" ? block.Text : asString(asRecord(block.Mention).content) ?? ""))
      .filter(Boolean)
      .join("\n");
    if (Object.keys(user).length) {
      builder.prompt(text);
      continue;
    }
    builder.reply(text);
    for (const block of blocks) {
      const use = asRecord(block.ToolUse);
      if (use.name) builder.tool(String(use.name), use.input, asString(use.id));
    }
    for (const [toolId, raw] of Object.entries(asRecord(agent.tool_results))) {
      const result = asRecord(raw);
      builder.result(toolId, { error: Boolean(result.is_error), text: textOf(asRecord(result.content).Text ?? result.output) });
    }
  }
  return builder.build();
}

function zedRefs(ctx: ReaderContext, file: string): SessionRef[] {
  const db = openSqlite(file, ctx);
  if (!db || !hasTable(db, "threads")) return [];
  const cols = columns(db, "threads");
  const folders = cols.has("folder_paths") ? "folder_paths" : "null as folder_paths";
  const parent = cols.has("parent_id") ? "where parent_id is null" : "";
  const rows = db.prepare(`select id, updated_at from threads ${parent}`).all() as Row[];
  const body = db.prepare(`select data_type, data, ${folders} from threads where id = ?`);
  return rows.map((row) => ({
    agent: "zed",
    path: `${file}#${row.id}`,
    mtimeMs: epochMs(row.updated_at),
    load: () => {
      const thread = body.get(row.id) as Row | undefined;
      if (!thread) return null;
      const data = thread.data as Buffer | string;
      const raw = thread.data_type === "zstd" ? zstdDecompress(Buffer.isBuffer(data) ? data : Buffer.from(data))?.toString("utf8") : String(data);
      if (!raw) return null;
      const folder = asString(String(thread.folder_paths ?? "").split("\n")[0]);
      return parseZedThread(String(row.id), json(raw), folder);
    },
  }));
}

export const zedReader: SessionReader = {
  id: "zed",
  label: "Zed",
  find: (ctx) => {
    const file =
      ctx.platform === "darwin"
        ? path.join(ctx.home, "Library", "Application Support", "Zed", "threads", "threads.db")
        : ctx.platform === "win32" && ctx.env.LOCALAPPDATA
          ? path.join(ctx.env.LOCALAPPDATA, "Zed", "threads", "threads.db")
          : path.join(ctx.env.FLATPAK_XDG_DATA_HOME ? path.join(ctx.env.FLATPAK_XDG_DATA_HOME, "zed") : xdgDataDir(ctx, "zed"), "threads", "threads.db");
    return zedRefs(ctx, file);
  },
};

