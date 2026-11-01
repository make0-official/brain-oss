import path from "node:path";
import { type ParsedSession, SessionBuilder, asArray, asRecord, asString, fromFileUri, textOf } from "../session";
import {
  type ReaderContext,
  type SessionReader,
  type SessionRef,
  exists,
  fileRefs,
  hasTable,
  listFiles,
  mtimeMs,
  openSqlite,
  readJson,
  readJsonLines,
  subdirs,
  vscodeUserDirs,
} from "../store";
import { parseCopilotEvents } from "./jsonl";

type Path = Array<string | number>;

function getAt(root: unknown, keys: Path): unknown {
  let node: unknown = root;
  for (const key of keys) node = node == null ? undefined : (node as Record<string | number, unknown>)[key];
  return node;
}

function setAt(root: Record<string, unknown>, keys: Path, value: unknown): void {
  let node: Record<string | number, unknown> = root;
  for (const [index, key] of keys.entries()) {
    if (index === keys.length - 1) node[key] = value;
    else {
      if (node[key] == null || typeof node[key] !== "object") node[key] = typeof keys[index + 1] === "number" ? [] : {};
      node = node[key] as Record<string | number, unknown>;
    }
  }
}

/** VS Code's chat session file: whole JSON, or a JSONL mutation log (0 initial, 1 set, 2 push, 3 delete). */
export function replayChatSession(file: string): Record<string, unknown> {
  if (file.endsWith(".json")) return asRecord(readJson(file));
  let state: Record<string, unknown> = {};
  for (const record of readJsonLines(file)) {
    const keys = asArray(record.k) as Path;
    if (record.kind === 0) state = asRecord(record.v);
    else if (record.kind === 1) setAt(state, keys, record.v);
    else if (record.kind === 2) {
      const target = getAt(state, keys);
      const items = asArray(record.v);
      if (Array.isArray(target)) {
        if (typeof record.i === "number") target.splice(record.i, target.length - record.i, ...items);
        else target.push(...items);
      } else setAt(state, keys, items);
    } else if (record.kind === 3) {
      const parent = getAt(state, keys.slice(0, -1));
      if (parent && typeof parent === "object") delete (parent as Record<string | number, unknown>)[keys[keys.length - 1]];
    }
  }
  return state;
}

export function parseCopilotChatSession(file: string, cwd: string | null): ParsedSession {
  const state = replayChatSession(file);
  const builder = new SessionBuilder("copilot-chat", String(state.sessionId ?? path.basename(file).replace(/\.jsonl?$/, "")));
  builder.title(state.customTitle).time(state.creationDate).time(state.lastMessageDate).setCwd(cwd ?? fromFileUri(state.workingDirectory));
  for (const request of asArray(state.requests).map(asRecord)) {
    builder.time(request.timestamp);
    const message = request.message;
    builder.prompt(typeof message === "string" ? message : textOf(asRecord(message).text ?? message));
    const reply: string[] = [];
    for (const part of asArray(request.response).map(asRecord)) {
      const kind = String(part.kind ?? "");
      if ((!kind || kind === "markdownContent") && typeof part.value === "string") reply.push(part.value);
      if (kind === "markdownContent" && asRecord(part.content).value) reply.push(String(asRecord(part.content).value));
      if (kind === "textEditGroup") builder.file(fromFileUri(asRecord(part.uri).path ? `file://${asRecord(part.uri).path}` : part.uri));
      if (kind === "toolInvocationSerialized") {
        const commandLine = asRecord(part.toolSpecificData).commandLine;
        const command = typeof commandLine === "string" ? commandLine : asString(asRecord(commandLine).toolEdited) ?? asString(asRecord(commandLine).original);
        if (command) builder.command(command);
      }
    }
    if (reply.join("").trim()) builder.reply(reply.join(""));
  }
  return builder.build();
}

function workspaceFolder(storageDir: string): string | null {
  const workspace = asRecord(readJson(path.join(storageDir, "workspace.json")));
  return fromFileUri(workspace.folder ?? workspace.workspace);
}

export const copilotChatReader: SessionReader = {
  id: "copilot-chat",
  label: "VS Code Copilot Chat",
  find: (ctx) => {
    const refs: SessionRef[] = [];
    const users = vscodeUserDirs(ctx, ["Code", "Code - Insiders", "VSCodium"]);
    const withProfiles = users.flatMap((user) => [user, ...subdirs(path.join(user, "profiles"))]);
    for (const user of withProfiles) {
      for (const storage of subdirs(path.join(user, "workspaceStorage"))) {
        const cwd = workspaceFolder(storage);
        const chats = listFiles(path.join(storage, "chatSessions"), (name) => /\.jsonl?$/.test(name));
        refs.push(...fileRefs("copilot-chat", chats, (file) => parseCopilotChatSession(file, cwd)));
        const transcripts = listFiles(path.join(storage, "GitHub.copilot-chat", "transcripts"), (name) => name.endsWith(".jsonl"));
        refs.push(...fileRefs("copilot-chat", transcripts, (file) => parseCopilotEvents("copilot-chat", file, cwd)));
      }
      const empty = listFiles(path.join(user, "globalStorage", "emptyWindowChatSessions"), (name) => /\.jsonl?$/.test(name));
      refs.push(...fileRefs("copilot-chat", empty, (file) => parseCopilotChatSession(file, null)));
    }
    return refs;
  },
};

const LEGACY_TOOL = /<(execute_command|write_to_file|replace_in_file|apply_diff|insert_content|search_and_replace|new_rule)>([\s\S]*?)<\/\1>/g;
const TOOL_RESULT = /^\[[^\]]+\] Result:/;

/** Cline-family tasks: Anthropic messages, with the legacy XML tool calls inside assistant text. */
export function parseClineTask(agent: string, file: string, meta: Record<string, unknown>): ParsedSession {
  const builder = new SessionBuilder(agent, String(meta.id ?? path.basename(path.dirname(file))));
  builder
    .setCwd(meta.cwdOnTaskInitialization ?? meta.workspace ?? meta.cwd ?? meta.workspace_root)
    .title(asRecord(meta.metadata).title)
    .time(meta.ts ?? meta.created_at)
    .time(meta.updated_at)
    .time(mtimeMs(file));
  const doc = readJson(file);
  const messages = Array.isArray(doc) ? doc : asArray(asRecord(doc).messages);
  for (const message of messages.map(asRecord)) {
    if (message.isSummary) continue;
    builder.time(message.ts);
    if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : asArray(message.content);
      for (const block of blocks.map(asRecord)) {
        if (block.type !== "text") continue;
        const text = String(block.text ?? "");
        if (!TOOL_RESULT.test(text)) {
          builder.prompt(text);
          continue;
        }
        // A tool result; what the person said rides inside it as <feedback> or <answer>.
        const said = text.match(/<(?:feedback|answer|user_message)>([\s\S]*?)<\/(?:feedback|answer|user_message)>/);
        if (said) builder.prompt(said[1]);
      }
      builder.message("user", asArray(message.content).filter((block) => asRecord(block).type !== "text"));
      continue;
    }
    builder.message(message.role, message.content);
    if (message.role !== "assistant") continue;
    const text = textOf(message.content);
    for (const match of text.matchAll(LEGACY_TOOL)) {
      const inner = (tag: string) => match[2].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
      if (match[1] === "execute_command") {
        const command = inner("command");
        if (command) builder.command(command);
      } else builder.file(inner("path"));
    }
    // Keep the answer readable: drop the XML the model used to call tools.
    builder.reply(text.replace(LEGACY_TOOL, "").replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim() || null);
  }
  return builder.build();
}

function extensionTasks(ctx: ReaderContext, extension: string): Array<{ file: string; storage: string }> {
  return vscodeUserDirs(ctx).flatMap((user) => {
    const storage = path.join(user, "globalStorage", extension);
    return subdirs(path.join(storage, "tasks"))
      .map((task) => ({ file: path.join(task, "api_conversation_history.json"), storage }))
      .filter((task) => exists(task.file));
  });
}

function rooFamily(id: string, label: string, extension: string): SessionReader {
  return {
    id,
    label,
    find: (ctx) =>
      extensionTasks(ctx, extension).map(({ file }) => ({
        agent: id,
        path: file,
        mtimeMs: mtimeMs(file),
        load: () => parseClineTask(id, file, asRecord(readJson(path.join(path.dirname(file), "history_item.json")))),
      })),
  };
}

export const rooReader = rooFamily("roo", "Roo Code", "rooveterinaryinc.roo-cline");
export const kiloExtensionReader = rooFamily("kilocode", "Kilo Code", "kilocode.kilo-code");

export const clineReader: SessionReader = {
  id: "cline",
  label: "Cline",
  find: (ctx) => {
    const refs: SessionRef[] = [];
    // The VS Code extension: task metadata lives in state/taskHistory.json.
    const histories = new Map<string, Map<string, Record<string, unknown>>>();
    for (const { file, storage } of extensionTasks(ctx, "saoudrizwan.claude-dev")) {
      if (!histories.has(storage)) {
        const entries = asArray(readJson(path.join(storage, "state", "taskHistory.json"))).map(asRecord);
        histories.set(storage, new Map(entries.map((entry) => [String(entry.id), entry])));
      }
      const meta = histories.get(storage)!.get(path.basename(path.dirname(file))) ?? {};
      refs.push({ agent: "cline", path: file, mtimeMs: mtimeMs(file), load: () => parseClineTask("cline", file, meta) });
    }
    // The CLI/SDK: <sessions>/<id>/<id>.messages.json with a <id>.json manifest.
    const dataDir = ctx.env.CLINE_DATA_DIR || path.join(ctx.env.CLINE_DIR || path.join(ctx.home, ".cline"), "data");
    const sessionsDir = ctx.env.CLINE_SESSION_DATA_DIR || path.join(dataDir, "sessions");
    for (const session of subdirs(sessionsDir)) {
      const id = path.basename(session);
      const file = path.join(session, `${id}.messages.json`);
      if (!exists(file)) continue;
      refs.push({
        agent: "cline",
        path: file,
        mtimeMs: mtimeMs(file),
        load: () => parseClineTask("cline", file, { id, ...asRecord(readJson(path.join(session, `${id}.json`))) }),
      });
    }
    return refs;
  },
};

/** Cursor IDE: `composerData:<id>` and `bubbleId:<composer>:<bubble>` rows in `cursorDiskKV`. */
function cursorIdeRefs(ctx: ReaderContext, file: string): SessionRef[] {
  const db = openSqlite(file, ctx);
  if (!db || !hasTable(db, "cursorDiskKV")) return [];
  const getValue = db.prepare("select value from cursorDiskKV where key = ?");
  // Newer stores index every chat in `composerHeaders`; filtering there skips reading the
  // chats outside the window, which on a large store is most of its gigabytes.
  const composers: Iterable<{ key: string; value: string | Buffer | null }> = hasTable(db, "composerHeaders")
    ? (function* () {
        const ids = db
          .prepare("select composerId from composerHeaders where coalesce(isSubagent, 0) = 0 and coalesce(lastUpdatedAt, 0) >= ?")
          .all(ctx.since ?? 0) as Array<{ composerId: string }>;
        for (const { composerId } of ids) {
          const key = `composerData:${composerId}`;
          yield { key, value: (getValue.get(key) as { value?: string | Buffer } | undefined)?.value ?? null };
        }
      })()
    : (db.prepare("select key, value from cursorDiskKV where key >= 'composerData:' and key < 'composerData;'").iterate() as Iterable<{
        key: string;
        value: string | Buffer | null;
      }>);
  const refs: SessionRef[] = [];
  for (const row of composers) {
    let composer: Record<string, unknown>;
    try {
      composer = asRecord(JSON.parse(String(row.value ?? "")));
    } catch {
      continue;
    }
    const headers = asArray(composer.fullConversationHeadersOnly).map(asRecord);
    const inline = asArray(composer.conversation).map(asRecord);
    if (!headers.length && !inline.length) continue;
    const id = String(composer.composerId ?? row.key.slice("composerData:".length));
    refs.push({
      agent: "cursor",
      path: `${file}#${id}`,
      mtimeMs: Number(composer.lastUpdatedAt ?? composer.createdAt) || 0,
      load: () => {
        const builder = new SessionBuilder("cursor", id);
        const workspace = asRecord(asRecord(composer.workspaceIdentifier).uri);
        builder.title(composer.name).time(composer.createdAt).time(composer.lastUpdatedAt).setCwd(workspace.fsPath ?? workspace.path);
        const bubbles: Array<Record<string, unknown>> = inline.length
          ? inline
          : headers.map((header) => {
              const value = (getValue.get(`bubbleId:${id}:${header.bubbleId}`) as { value?: string | Buffer } | undefined)?.value;
              try {
                return { createdAt: header.createdAt, ...asRecord(JSON.parse(String(value ?? "{}"))) };
              } catch {
                return {};
              }
            });
        for (const bubble of bubbles) {
          builder.time(bubble.createdAt ?? bubble.timestamp);
          builder.setCwd(bubble.workspaceProjectDir ?? fromFileUri(asArray(bubble.workspaceUris)[0]));
          const text = asString(bubble.text) ?? asString(bubble.rawText);
          if (bubble.type === 1) builder.prompt(text);
          else if (text) builder.reply(text);
          const tool = asRecord(bubble.toolFormerData);
          if (tool.name) {
            const toolId = asString(tool.toolCallId) ?? asString(bubble.bubbleId);
            // Cursor's own tool names carry a version suffix: `run_terminal_cmd_v2`, `edit_file_v2`.
            builder.tool(String(tool.name).replace(/_v\d+$/, ""), tool.params ?? tool.rawArgs, toolId);
            builder.result(toolId, { error: tool.status === "error", text: textOf(tool.result) });
          }
        }
        return builder.build();
      },
    });
  }
  return refs;
}

export const cursorIdeReader: SessionReader = {
  id: "cursor",
  label: "Cursor",
  find: (ctx) => vscodeUserDirs(ctx, ["Cursor"]).flatMap((user) => cursorIdeRefs(ctx, path.join(user, "globalStorage", "state.vscdb"))),
};
