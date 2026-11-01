import fs from "node:fs";
import path from "node:path";
import {
  type ParsedSession,
  SessionBuilder,
  asArray,
  asRecord,
  asString,
  fromFileUri,
  parseMaybeJson,
  patchFiles,
  textOf,
  toIso,
} from "../session";
import {
  type ReaderContext,
  type SessionReader,
  decodeProjectDir,
  exists,
  fileRefs,
  listFiles,
  mtimeMs,
  parseJsonLines,
  readJson,
  readJsonLines,
  readText,
  subdirs,
  xdgDataDir,
  zstdDecompress,
} from "../store";

const jsonl = (name: string) => name.endsWith(".jsonl");

/** Gemini CLI: whole-session `.json`, or `.jsonl` with `$set` and `$rewindTo` control lines. */
export function parseGeminiSession(file: string): ParsedSession {
  const builder = new SessionBuilder("gemini", path.basename(file).replace(/\.jsonl?$/, ""));
  let messages: Array<Record<string, unknown>> = [];
  if (file.endsWith(".json")) {
    const doc = asRecord(readJson(file));
    builder.id(doc.sessionId).time(doc.startTime).time(doc.lastUpdated);
    messages = asArray(doc.messages).map(asRecord);
  } else {
    for (const record of readJsonLines(file)) {
      if (record.sessionId) builder.id(record.sessionId).time(record.startTime).time(record.lastUpdated);
      const set = asRecord(record.$set);
      if (Array.isArray(set.messages)) messages = set.messages.map(asRecord);
      if (record.$rewindTo) {
        const index = messages.findIndex((message) => message.id === record.$rewindTo);
        if (index >= 0) messages = messages.slice(0, index);
      }
      if (record.type && record.id) messages = [...messages.filter((message) => message.id !== record.id), record];
    }
  }
  for (const message of messages) {
    builder.time(message.timestamp);
    builder.message(message.type === "user" ? "user" : message.type === "gemini" || message.type === "model" ? "assistant" : "", message.content);
    for (const call of asArray(message.toolCalls).map(asRecord)) {
      const id = asString(call.id) ?? `${message.id}:${call.name}`;
      builder.tool(String(call.name ?? ""), call.args, id);
      builder.result(id, { error: call.status === "error", text: textOf(call.result ?? call.resultDisplay) });
    }
  }
  const projectRoot = readText(path.join(path.dirname(path.dirname(file)), ".project_root"))?.trim();
  if (projectRoot) builder.setCwd(projectRoot);
  return builder.build();
}

export const geminiReader: SessionReader = {
  id: "gemini",
  label: "Gemini CLI",
  find: (ctx) => {
    const tmp = path.join(ctx.env.GEMINI_CLI_HOME ? path.join(ctx.env.GEMINI_CLI_HOME, ".gemini") : path.join(ctx.home, ".gemini"), "tmp");
    const files = subdirs(tmp).flatMap((project) =>
      listFiles(path.join(project, "chats"), (name) => /\.jsonl?$/.test(name), { depth: 0 }),
    );
    // A resumed `.json` session can be rewritten as `.jsonl`; keep the newer generation.
    const jsonlIds = new Set(files.filter((file) => file.endsWith(".jsonl")).map((file) => file.replace(/\.jsonl$/, "")));
    return fileRefs("gemini", files.filter((file) => !(file.endsWith(".json") && jsonlIds.has(file.replace(/\.json$/, "")))), parseGeminiSession);
  },
};

/** Antigravity: `source`/`type` steps with the user's request wrapped in tags. */
export function parseAntigravitySession(file: string): ParsedSession {
  const builder = new SessionBuilder("antigravity", path.basename(path.dirname(path.dirname(path.dirname(file)))));
  for (const record of readJsonLines(file)) {
    builder.time(record.created_at);
    const content = String(record.content ?? "");
    if (record.source === "USER_EXPLICIT") {
      const metadata = content.match(/<ADDITIONAL_METADATA>([\s\S]*?)<\/ADDITIONAL_METADATA>/);
      if (metadata) builder.setCwd(asRecord(parseMaybeJson(metadata[1])).cwd);
      builder.prompt(content.replace(/^Comments on artifact URI:.*$/gm, ""));
      continue;
    }
    if (record.source !== "MODEL") continue;
    if (!record.type || record.type === "PLANNER_RESPONSE") {
      builder.reply(content);
      for (const call of asArray(record.tool_calls).map(asRecord)) {
        const args = asRecord(call.args ?? call.arguments);
        const decoded = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, parseMaybeJson(value)]));
        const name = String(call.name ?? "");
        if (name === "run_command") builder.tool("run_command", decoded, asString(call.id));
        else if (name === "replace_file_content" || name === "write_to_file") builder.tool("write_to_file", decoded);
      }
    } else if (record.type === "RUN_COMMAND" || record.type === "GENERIC") {
      const exit = content.match(/The command exited with code (-?\d+)/);
      const task = content.match(/Task Description:\s*(.+)/);
      if (task && exit && exit[1] !== "0") builder.command(task[1], null, { failed: true });
    }
  }
  return builder.build();
}

export const antigravityReader: SessionReader = {
  id: "antigravity",
  label: "Antigravity",
  find: (ctx) => {
    const gemini = path.join(ctx.home, ".gemini");
    const files = subdirs(gemini)
      .filter((dir) => path.basename(dir).startsWith("antigravity"))
      .flatMap((root) => subdirs(path.join(root, "brain")))
      .map((session) => path.join(session, ".system_generated", "logs", "transcript.jsonl"))
      .filter(exists);
    return fileRefs("antigravity", files, parseAntigravitySession);
  },
};

/** Flat `{role, content, tool_calls}` lines (Command Code v2, ZCode, Reasonix), or Command Code v3 envelopes. */
export function parseFlatSession(agent: string, file: string, project?: string | null): ParsedSession {
  const builder = new SessionBuilder(agent, path.basename(file, ".jsonl"));
  for (const record of readJsonLines(file)) {
    builder.time(record.timestamp ?? record.createdAt);
    if (record.type === "session") {
      builder.id(record.id).setCwd(record.cwd).title(record.title);
      continue;
    }
    builder.id(record.sessionId);
    const message = record.type === "message" ? asRecord(record.message) : record;
    builder.message(message.role, message.content, {
      toolCalls: message.tool_calls ?? message.toolCalls,
      toolCallId: message.tool_call_id ?? message.toolCallId,
      isError: message.is_error ?? message.isError,
    });
  }
  const session = builder.build();
  // The folder name is a lossy slug; use it only when the transcript names no directory.
  if (!session.cwd && project) session.project = project;
  return session;
}

export const commandCodeReader: SessionReader = {
  id: "commandcode",
  label: "Command Code",
  find: (ctx) => {
    const root = path.join(ctx.home, ".commandcode", "projects");
    const files = subdirs(root).flatMap((project) => listFiles(project, (name) => jsonl(name) && !name.endsWith(".checkpoints.jsonl")));
    return fileRefs("commandcode", files, (file) => parseFlatSession("commandcode", file, decodedProject(path.basename(path.dirname(file)))));
  },
};

export const zcodeReader: SessionReader = {
  id: "zcode",
  label: "ZCode",
  find: (ctx) => {
    const files = subdirs(path.join(ctx.home, ".zcode", "projects")).flatMap((project) => listFiles(project, jsonl));
    return fileRefs("zcode", files, (file) => parseFlatSession("zcode", file, decodedProject(path.basename(path.dirname(file)))));
  },
};

/** A lossy `-work-api` folder name, resolved on disk when it can be, else its last part. */
function decodedProject(encoded: string): string | null {
  const resolved = decodeProjectDir(encoded);
  return resolved ? path.basename(resolved) : encoded.replace(/^-+/, "").split("-").pop() || null;
}

export const reasonixReader: SessionReader = {
  id: "reasonix",
  label: "Reasonix",
  find: (ctx) => {
    const state = ctx.env.REASONIX_STATE_HOME || ctx.env.REASONIX_HOME || path.join(ctx.home, ".reasonix");
    const legacy = [path.join(ctx.home, "Library", "Application Support", "reasonix"), path.join(ctx.home, ".config", "reasonix")];
    const files = [state, ...legacy].flatMap((root) => [
      ...subdirs(path.join(root, "projects")).flatMap((project) => listFiles(path.join(project, "sessions"), jsonl)),
      ...listFiles(path.join(root, "sessions"), jsonl),
    ]);
    return fileRefs("reasonix", files, (file) => {
      const workspace = path.basename(path.dirname(path.dirname(file)));
      return parseFlatSession("reasonix", file, path.basename(path.dirname(file)) === "sessions" && workspace !== "projects" ? decodedProject(workspace) : null);
    });
  },
};

/** Kimi Code: `wire.jsonl` of context events, with `state.json` (workDir, title) beside the agents folder. */
export function parseKimiSession(file: string): ParsedSession {
  const sessionDir = path.dirname(path.dirname(path.dirname(file)));
  const builder = new SessionBuilder("kimi", path.basename(sessionDir));
  const state = asRecord(readJson(path.join(sessionDir, "state.json")));
  builder.setCwd(state.workDir).title(state.title).time(state.createdAt).time(state.updatedAt);
  let turn: string | null = null;
  let text = "";
  const flush = () => {
    if (text) builder.reply(text);
    text = "";
  };
  for (const record of readJsonLines(file)) {
    builder.time(record.time);
    if (record.type === "context.append_message") {
      const message = asRecord(record.message);
      if (message.role === "user") {
        flush();
        builder.message("user", message.content);
      } else builder.message(message.role, message.content, { toolCalls: message.toolCalls });
    }
    if (record.type !== "context.append_loop_event") continue;
    const event = asRecord(record.event);
    if (event.type === "tool.call") builder.tool(String(event.name ?? ""), event.args, asString(event.toolCallId));
    if (event.type === "tool.result") {
      const result = asRecord(event.result);
      builder.result(asString(event.toolCallId), { error: Boolean(result.isError ?? result.error), text: textOf(result) });
    }
    if (event.type === "content.part" && asRecord(event.part).type === "text") {
      if (event.turnId !== turn) flush();
      turn = asString(event.turnId);
      text += String(asRecord(event.part).text ?? "");
    }
  }
  flush();
  return builder.build();
}

export const kimiReader: SessionReader = {
  id: "kimi",
  label: "Kimi Code",
  find: (ctx) => {
    const root = path.join(ctx.env.KIMI_CODE_HOME || path.join(ctx.home, ".kimi-code"), "sessions");
    const files = subdirs(root)
      .flatMap(subdirs)
      .map((session) => path.join(session, "agents", "main", "wire.jsonl"))
      .filter(exists);
    return fileRefs("kimi", files, parseKimiSession);
  },
};

/** Kiro CLI (`<id>.jsonl` + `<id>.json`) and Kiro IDE (`messages.jsonl` + `session.json` in each `sess_` folder). */
export function parseKiroSession(file: string): ParsedSession {
  const ide = path.basename(file) === "messages.jsonl";
  const header = asRecord(readJson(ide ? path.join(path.dirname(file), "session.json") : file.replace(/\.jsonl$/, ".json")));
  const builder = new SessionBuilder("kiro", ide ? path.basename(path.dirname(file)) : path.basename(file, ".jsonl"));
  builder
    .id(header.id ?? header.session_id)
    .setCwd(header.cwd ?? asArray(header.workspacePaths)[0])
    .title(header.title)
    .time(header.createdAt ?? header.created_at)
    .time(header.lastModifiedAt);
  let assistantId: unknown = null;
  let assistantText = "";
  for (const record of readJsonLines(file)) {
    if (ide) {
      const payload = asRecord(record.payload);
      builder.time(record.timestamp);
      if (payload.type === "user") builder.prompt(textOf(payload.content));
      if (payload.type === "assistant" && payload.operationType !== "Reasoning") builder.reply(textOf(payload.content));
      continue;
    }
    const data = asRecord(record.data);
    builder.time(asRecord(data.meta).timestamp);
    const text = asArray(data.content)
      .map((part) => (asRecord(part).kind === "text" ? String(asRecord(part).data ?? "") : ""))
      .join("");
    if (record.kind === "Prompt") builder.prompt(text);
    if (record.kind === "AssistantMessage") {
      // One answer streams over several lines with the same message id.
      assistantText = data.message_id === assistantId ? assistantText + text : text;
      assistantId = data.message_id;
      builder.reply(assistantText);
    }
  }
  return builder.build();
}

export const kiroReader: SessionReader = {
  id: "kiro",
  label: "Kiro",
  find: (ctx) => {
    const root = path.join(ctx.home, ".kiro", "sessions");
    const cli = listFiles(path.join(root, "cli"), jsonl);
    const ide = subdirs(root)
      .filter((dir) => path.basename(dir) !== "cli")
      .flatMap(subdirs)
      .map((session) => path.join(session, "messages.jsonl"))
      .filter(exists);
    return fileRefs("kiro", [...cli, ...ide], parseKiroSession);
  },
};

/** Junie: `UserPromptEvent`s and agent blocks updated in place by `stepId`. */
export function parseJunieSession(file: string, index: Map<string, Record<string, unknown>>): ParsedSession {
  const id = path.basename(path.dirname(file));
  const builder = new SessionBuilder("junie", id);
  const entry = index.get(id) ?? {};
  builder.setCwd(entry.projectDir).title(entry.taskName).time(entry.createdAt).time(entry.updatedAt);
  const terminals = new Map<string, Record<string, unknown>>();
  for (const record of readJsonLines(file)) {
    builder.time(record.timestampMs);
    if (record.kind === "UserPromptEvent") builder.prompt(record.presentablePrompt ?? record.prompt);
    if (record.kind !== "SessionA2uxEvent") continue;
    const event = asRecord(asRecord(record.event).agentEvent);
    const step = String(event.stepId ?? "");
    if (event.kind === "TerminalBlockUpdatedEvent" && event.command) terminals.set(step, event);
    if (event.kind === "FileChangesBlockUpdatedEvent") {
      for (const change of asArray(event.changes).map(asRecord)) {
        builder.file(change.path ?? change.filePath ?? asRecord(change.afterContent).path ?? asRecord(change.beforeContent).path);
      }
    }
    if (event.kind === "AgentPatchCreatedEvent") for (const file of patchFiles(String(event.patch ?? ""))) builder.file(file.replace(/^\/\//, "/"));
    if (event.kind === "MarkdownBlockUpdatedEvent") builder.reply(event.text);
    if (event.kind === "ResultBlockUpdatedEvent") builder.reply(event.result);
  }
  for (const terminal of terminals.values()) {
    const failed = terminal.status === "FAILED" || (typeof terminal.exitCode === "number" && terminal.exitCode !== 0);
    builder.command(String(terminal.command), null, { failed, error: failed ? String(terminal.presentableOutput ?? terminal.output ?? "").split("\n")[0] : undefined });
  }
  return builder.build();
}

export const junieReader: SessionReader = {
  id: "junie",
  label: "Junie",
  find: (ctx) => {
    const root = path.join(ctx.env.JUNIE_HOME || path.join(ctx.home, ".junie"), "sessions");
    const index = new Map(readJsonLines(path.join(root, "index.jsonl")).map((entry) => [String(entry.sessionId), entry]));
    const files = subdirs(root)
      .map((session) => path.join(session, "events.jsonl"))
      .filter(exists);
    return fileRefs("junie", files, (file) => parseJunieSession(file, index));
  },
};

/** MiniMax Code: `{message: {role, content}}` lines; compaction summaries skipped. */
export function parseMcodeSession(file: string): ParsedSession {
  const builder = new SessionBuilder("mcode", path.basename(path.dirname(file)).replace(/^[\d-]+-session_/, ""));
  for (const record of readJsonLines(file)) {
    const message = asRecord(record.message);
    builder.time(message.timestamp);
    if (message.role === "compactionSummary") continue;
    builder.message(message.role === "toolResult" ? "tool" : message.role, message.content, { toolCallId: message.toolCallId, isError: message.isError });
  }
  return builder.build();
}

export const mcodeReader: SessionReader = {
  id: "mcode",
  label: "MiniMax Code",
  find: (ctx) => {
    const files = listFiles(path.join(ctx.home, ".minimax", "v2", "sessions"), (name) => name === "messages.jsonl", { depth: 4 });
    return fileRefs("mcode", files, parseMcodeSession);
  },
};

/** Muse Code: event-sourced records, some wrapped in `retained_frame` transactions. */
export function parseMuseSession(file: string): ParsedSession {
  const sessionId = path.basename(path.dirname(file));
  const builder = new SessionBuilder("muse", sessionId);
  const records: Array<Record<string, unknown>> = [];
  for (const record of readJsonLines(file)) {
    if (record.retained_frame) {
      for (const child of asArray(record.children).map(asRecord)) {
        const parsed = asRecord(parseMaybeJson(child.record_json));
        if (Object.keys(parsed).length) records.push(parsed);
      }
    } else records.push(record);
  }
  for (const record of records) {
    const stream = asRecord(record.stream);
    if (stream.kind !== "session" || (stream.id && stream.id !== sessionId)) continue;
    builder.time(record.recorded_at);
    const payload = asRecord(record.payload);
    if (record.payload_type === "runtime.session.metadata") builder.setCwd(asRecord(payload.record).workspace_root);
    if (record.payload_type === "runtime.session.route_facts") builder.setCwd(payload.cwd ?? asRecord(payload.record).cwd);
    if (record.payload_type === "session.name.changed") builder.title(payload.new_name, true);
    if (record.payload_type !== "runtime.session" || payload.kind !== "run") continue;
    const event = asRecord(payload.event);
    if (event.kind === "started") builder.prompt(event.prompt);
    if (event.kind === "assistant_message_committed") builder.reply(event.text);
    if (event.kind === "assistant_tool_calls_committed") {
      for (const call of asArray(event.tool_calls).map(asRecord)) builder.tool(String(call.name ?? ""), call.args, asString(call.call_id) ?? asString(call.id));
    }
    if (event.kind === "tool_result_batch_committed") {
      for (const result of asArray(event.results).map(asRecord)) {
        const output = asRecord(parseMaybeJson(result.text));
        builder.result(asString(result.tool_call_id), {
          text: String(output.output ?? result.text ?? ""),
          exitCode: typeof output.exit_code === "number" ? output.exit_code : null,
        });
      }
    }
  }
  return builder.build();
}

export const museReader: SessionReader = {
  id: "muse",
  label: "Muse Code",
  find: (ctx) => {
    const files = listFiles(xdgDataDir(ctx, path.join("muse", "sessions")), (name) => name === "session.jsonl", {
      depth: 4,
      skipDir: (name) => name === "subagent",
    });
    return fileRefs("muse", files, parseMuseSession);
  },
};

/**
 * Copilot's event log: Copilot CLI's `events.jsonl` and VS Code Copilot
 * Chat's `transcripts/*.jsonl` write the same `type`/`data` events.
 */
export function parseCopilotEvents(agent: string, file: string, cwd?: string | null): ParsedSession {
  const builder = new SessionBuilder(agent, path.basename(file, ".jsonl"));
  if (agent === "copilot") builder.id(path.basename(path.dirname(file)));
  builder.setCwd(cwd);
  for (const record of readJsonLines(file)) {
    const data = asRecord(record.data);
    if (data.agentId) continue; // a sub-agent's records inside the parent log
    builder.time(record.timestamp);
    if (record.type === "session.start") builder.id(data.sessionId).setCwd(asRecord(data.context).cwd);
    if (record.type === "session.info" && data.title) builder.title(data.title);
    if (record.type === "user.message") builder.prompt(textOf(data.content));
    if (record.type === "assistant.message") builder.reply(textOf(data.content));
    if (record.type === "tool.execution_start") builder.tool(String(data.toolName ?? ""), data.arguments, asString(data.toolCallId));
    if (record.type === "tool.execution_complete") {
      const result = asRecord(data.result);
      builder.result(asString(data.toolCallId), { error: data.success === false, text: textOf(result.content ?? result) });
    }
  }
  return builder.build();
}

export const copilotReader: SessionReader = {
  id: "copilot",
  label: "Copilot CLI",
  find: (ctx) => {
    const root = path.join(ctx.env.COPILOT_HOME || path.join(ctx.home, ".copilot"), "session-state");
    const files = subdirs(root)
      .map((session) => path.join(session, "events.jsonl"))
      .filter(exists);
    return fileRefs("copilot", files, (file) => parseCopilotEvents("copilot", file));
  },
};

const CURSOR_TIMESTAMP = /<timestamp>([^<]+)<\/timestamp>/;

/** Cursor CLI agent transcripts: Anthropic-shaped lines without timestamps or ids. */
export function parseCursorTranscript(file: string): ParsedSession {
  const builder = new SessionBuilder("cursor", path.basename(file, ".jsonl"));
  // `<projects>/<encoded-path>/agent-transcripts/[<id>/]<id>.jsonl`
  const segments = file.split(path.sep);
  const projectDir = segments[segments.lastIndexOf("agent-transcripts") - 1] ?? "";
  const cwd = decodeProjectDir(projectDir);
  if (cwd) builder.setCwd(cwd);
  else builder.project(projectDir.split("-").pop());
  let stamped = false;
  for (const record of readJsonLines(file)) {
    const message = asRecord(record.message);
    const content = message.content ?? record.content;
    const stamp = JSON.stringify(content ?? "").match(CURSOR_TIMESTAMP);
    if (stamp) {
      const iso = toIso(stamp[1].replace(/\s*\(UTC[^)]*\)/, "").replace(/^\w+,\s*/, ""));
      if (iso) {
        builder.time(iso);
        stamped = true;
      }
    }
    builder.message(record.role ?? message.role, content);
  }
  if (!stamped) builder.time(mtimeMs(file));
  return builder.build();
}

export const cursorCliReader: SessionReader = {
  id: "cursor",
  label: "Cursor",
  find: (ctx) => {
    const root = path.join(ctx.env.CURSOR_CONFIG_DIR || path.join(ctx.home, ".cursor"), "projects");
    const files = subdirs(root).flatMap((project) =>
      listFiles(path.join(project, "agent-transcripts"), jsonl, { depth: 1, skipDir: (name) => name === "subagents" }),
    );
    return fileRefs("cursor", files, parseCursorTranscript);
  },
};

/** Grok Build: ACP `updates.jsonl` chunks joined per prompt, `summary.json` for the rest. */
export function parseGrokSession(file: string): ParsedSession {
  const dir = path.dirname(file);
  const builder = new SessionBuilder("grok", path.basename(dir));
  const summary = asRecord(readJson(path.join(dir, "summary.json")));
  const info = asRecord(summary.info);
  builder
    .id(info.id)
    .setCwd(info.cwd ?? readText(path.join(path.dirname(dir), ".cwd"))?.trim())
    .title(summary.title ?? info.title)
    .time(info.created_at ?? summary.created_at)
    .time(info.updated_at ?? summary.updated_at);
  let current: { role: string; key: string; text: string } | null = null;
  const flush = () => {
    if (!current) return;
    if (current.role === "user") builder.prompt(current.text);
    else builder.reply(current.text);
    current = null;
  };
  for (const record of readJsonLines(file)) {
    const params = asRecord(record.params);
    const update = asRecord(params.update);
    const meta = asRecord(params._meta);
    builder.time(record.timestamp ?? meta.agentTimestampMs);
    const kind = update.sessionUpdate;
    if (kind === "tool_call") {
      const input = asRecord(update.rawInput);
      if (input.command) builder.command(String(input.command), asString(update.toolCallId));
      for (const location of asArray(update.locations)) if (update.kind === "edit") builder.file(asRecord(location).path);
      continue;
    }
    if (kind !== "user_message_chunk" && kind !== "agent_message_chunk") continue;
    const role = kind === "user_message_chunk" ? "user" : "assistant";
    const key = String(meta.promptId ?? meta.promptIndex ?? "");
    if (!current || current.role !== role || current.key !== key) {
      flush();
      current = { role, key, text: "" };
    }
    current.text += textOf(update.content);
  }
  flush();
  return builder.build();
}

export const grokReader: SessionReader = {
  id: "grok",
  label: "Grok Build",
  find: (ctx) => {
    const root = path.join(ctx.env.GROK_HOME || path.join(ctx.home, ".grok"), "sessions");
    const files = subdirs(root)
      .flatMap(subdirs)
      .map((session) => path.join(session, "updates.jsonl"))
      .filter(exists);
    return fileRefs("grok", files, parseGrokSession);
  },
};

/** DeepSeek Harness: `{type, data}` events after a `session` header, raw or zstd-framed. */
export function parseDeepSeekSession(file: string): ParsedSession | null {
  const raw = file.endsWith(".zstd") || file.endsWith(".zst") ? readZstd(file) : readText(file);
  if (raw == null) return null;
  const builder = new SessionBuilder("deepseek", path.basename(path.dirname(file)).replace(/^session-/, ""));
  for (const record of parseJsonLines(raw)) {
    builder.time(record.time ?? record.createdAt);
    const data = asRecord(record.data);
    if (record.type === "session") builder.id(record.id).setCwd(record.cwd);
    if (record.type === "session/title") builder.title(data.title, true);
    if (record.type === "user/message" && asRecord(data.source).kind === "user") builder.prompt(textOf(data.content));
    if (record.type === "assistant/message") builder.message("assistant", asRecord(data.message).content);
    if (record.type === "tool/call") builder.tool(String(data.name ?? ""), data.arguments, asString(data.callId));
    if (record.type === "tool/result") {
      const message = asRecord(data.message);
      builder.result(asString(asRecord(message.source).callId), { error: Boolean(message.isError), text: textOf(message.content) });
    }
  }
  return builder.build();
}

function readZstd(file: string): string | null {
  try {
    return zstdDecompress(fs.readFileSync(file))?.toString("utf8") ?? null;
  } catch {
    return null;
  }
}

export const deepSeekReader: SessionReader = {
  id: "deepseek",
  label: "DeepSeek Harness",
  find: (ctx) => {
    const root = path.join(ctx.env.DSH_HOME || path.join(ctx.home, ".dsh"), "sessions");
    const files = subdirs(root)
      .flatMap(subdirs)
      .flatMap((session) => {
        // The newest format generation in each session directory.
        const logs = listFiles(session, (name) => /^session(?:\.v\d+)?\.jsonl(?:\.zstd?)?$/.test(name));
        const generation = (file: string) => Number(path.basename(file).match(/\.v(\d+)\./)?.[1] ?? 0);
        return logs.sort((a, b) => generation(b) - generation(a)).slice(0, 1);
      });
    return fileRefs("deepseek", files, parseDeepSeekSession);
  },
};

/** Amp threads written to disk (older builds, or by deja's plugin). */
export function parseAmpThread(file: string): ParsedSession {
  const thread = asRecord(readJson(file));
  const builder = new SessionBuilder("amp", path.basename(file, ".json"));
  const tree = asRecord(asArray(asRecord(asRecord(thread.env).initial).trees)[0]);
  builder.id(thread.id).title(thread.title).time(thread.created).setCwd(fromFileUri(tree.uri));
  for (const message of asArray(thread.messages).map(asRecord)) {
    builder.message(message.role, message.content);
    for (const part of asArray(message.content).map(asRecord)) {
      if (part.type === "tool_result") {
        const run = asRecord(part.run);
        builder.result(asString(part.toolUseID) ?? asString(part.tool_use_id), {
          error: run.status === "error",
          text: textOf(asRecord(run.result).output ?? run.result ?? run.error),
          exitCode: typeof asRecord(run.result).exitCode === "number" ? (asRecord(run.result).exitCode as number) : null,
        });
      }
    }
  }
  return builder.build();
}

export const ampReader: SessionReader = {
  id: "amp",
  label: "Amp",
  find: (ctx) => fileRefs("amp", listFiles(xdgDataDir(ctx, path.join("amp", "threads")), (name) => name.endsWith(".json")), parseAmpThread),
};

/** CodeWhale: `{metadata, messages}` with Anthropic content blocks. */
export function parseCodeWhaleSession(file: string): ParsedSession {
  const doc = asRecord(readJson(file));
  const metadata = asRecord(doc.metadata);
  const builder = new SessionBuilder("codewhale", path.basename(file, ".json"));
  builder.id(metadata.id).title(metadata.title).setCwd(metadata.workspace).time(metadata.created_at).time(metadata.updated_at);
  for (const message of asArray(doc.messages).map(asRecord)) builder.message(message.role, message.content);
  return builder.build();
}

export const codeWhaleReader: SessionReader = {
  id: "codewhale",
  label: "CodeWhale",
  find: (ctx) => {
    const roots = [path.join(ctx.env.CODEWHALE_HOME || path.join(ctx.home, ".codewhale"), "sessions"), path.join(ctx.home, ".deepseek", "sessions")];
    return fileRefs("codewhale", roots.flatMap((root) => listFiles(root, (name) => name.endsWith(".json"))), parseCodeWhaleSession);
  },
};

/** Continue: `history[]` of messages, tool calls under `toolCallStates`, `sessions.json` for dates and folders. */
export function parseContinueSession(file: string, list: Map<string, Record<string, unknown>>): ParsedSession {
  const doc = asRecord(readJson(file));
  const id = String(doc.sessionId ?? path.basename(file, ".json"));
  const entry = list.get(id) ?? {};
  const builder = new SessionBuilder("continue", id);
  builder
    .title(doc.title ?? entry.title)
    .setCwd(doc.workspaceDirectory ?? entry.workspaceDirectory)
    .time(entry.dateCreated ?? mtimeMs(file))
    .time(mtimeMs(file));
  for (const item of asArray(doc.history).map(asRecord)) {
    const message = asRecord(item.message);
    if (message.role === "system" || message.role === "tool") continue;
    builder.message(message.role, message.content);
    for (const state of asArray(item.toolCallStates).map(asRecord)) {
      const fn = asRecord(asRecord(state.toolCall).function);
      const id = asString(state.toolCallId);
      builder.tool(String(fn.name ?? ""), state.parsedArgs ?? fn.arguments, id);
      builder.result(id, { error: state.status === "errored", text: textOf(state.output) });
    }
  }
  return builder.build();
}

export const continueReader: SessionReader = {
  id: "continue",
  label: "Continue",
  find: (ctx) => {
    const root = path.join(ctx.env.CONTINUE_GLOBAL_DIR || path.join(ctx.home, ".continue"), "sessions");
    const list = new Map(asArray(readJson(path.join(root, "sessions.json"))).map((entry) => [String(asRecord(entry).sessionId), asRecord(entry)]));
    const files = listFiles(root, (name) => name.endsWith(".json") && name !== "sessions.json");
    return fileRefs("continue", files, (file) => parseContinueSession(file, list));
  },
};

/** aider: one Markdown history holds many sessions, each opened by `# aider chat started at`. */
export function parseAiderHistory(file: string): ParsedSession[] {
  const text = readText(file) ?? "";
  const sessions: ParsedSession[] = [];
  const chunks = text.split(/^# aider chat started at /m).slice(1);
  for (const chunk of chunks) {
    const started = chunk.split("\n")[0].trim();
    const builder = new SessionBuilder("aider", started.replace(/\D/g, ""));
    builder.time(started).setCwd(path.dirname(file));
    let prompt: string[] = [];
    let reply: string[] = [];
    let inFence = false;
    const flushPrompt = () => {
      if (prompt.length) builder.prompt(prompt.join("\n"));
      prompt = [];
    };
    const flushReply = () => {
      if (reply.join("").trim()) builder.reply(reply.join("\n"));
      reply = [];
    };
    for (const line of chunk.split("\n").slice(1)) {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (!inFence && line.startsWith("#### ")) {
        flushReply();
        const typed = line.slice(5);
        const run = typed.match(/^(?:\/run|\/test|!)\s*(.+)/);
        if (run) builder.command(run[1]);
        else if (!typed.startsWith("/")) prompt.push(typed);
        continue;
      }
      if (!inFence && line.startsWith("> ")) {
        flushPrompt();
        const applied = line.match(/^> Applied edit to (.+)$/);
        if (applied) builder.file(applied[1].trim());
        continue;
      }
      flushPrompt();
      reply.push(line);
    }
    flushPrompt();
    flushReply();
    const session = builder.build();
    if (session.prompts.length) sessions.push(session);
  }
  return sessions;
}

export const aiderReader: SessionReader = {
  id: "aider",
  label: "aider",
  find: (ctx) => {
    const files = [path.join(ctx.home, ".aider.chat.history.md"), ctx.env.AIDER_CHAT_HISTORY_FILE].filter(
      (file): file is string => Boolean(file) && exists(file!),
    );
    return fileRefs("aider", files, parseAiderHistory);
  },
};

/** Goose before 1.10: a metadata line, then `{role, created, content}` messages. */
export function parseGooseJsonl(file: string): ParsedSession {
  const builder = new SessionBuilder("goose", path.basename(file, ".jsonl"));
  for (const record of readJsonLines(file)) {
    if (record.working_dir) builder.id(record.id).setCwd(record.working_dir).title(record.description).time(record.created_at);
    builder.time(record.created);
    if (record.role) gooseMessage(builder, String(record.role), record.content);
  }
  return builder.build();
}

/** Goose content blocks: `text`, `toolRequest` and `toolResponse`. */
export function gooseMessage(builder: SessionBuilder, role: string, content: unknown): void {
  builder.message(role, content);
  for (const block of asArray(content).map(asRecord)) {
    if (block.type === "toolRequest") {
      const call = asRecord(asRecord(block.toolCall).value);
      builder.tool(String(call.name ?? ""), call.arguments, asString(block.id));
    }
    if (block.type === "toolResponse") {
      const result = asRecord(block.toolResult);
      builder.result(asString(block.id), { error: result.status === "error", text: textOf(result.value ?? result.error) });
    }
  }
}

export function gooseRoots(ctx: ReaderContext): string[] {
  const roots = ctx.env.GOOSE_PATH_ROOT
    ? [path.join(ctx.env.GOOSE_PATH_ROOT, "data")]
    : [
        xdgDataDir(ctx, "goose"),
        path.join(ctx.home, ".local", "share", "Block", "goose"),
        path.join(ctx.home, "Library", "Application Support", "Block", "goose"),
        path.join(ctx.home, "Library", "Application Support", "goose"),
      ];
  if (ctx.platform === "win32" && ctx.env.APPDATA) roots.push(path.join(ctx.env.APPDATA, "Block", "goose", "data"));
  return roots.map((root) => path.join(root, "sessions"));
}
