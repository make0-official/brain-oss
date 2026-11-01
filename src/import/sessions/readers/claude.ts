import path from "node:path";
import { type ParsedSession, SessionBuilder, asRecord, asString } from "../session";
import { type ReaderContext, type SessionReader, appConfigDirs, fileRefs, listFiles, readJsonLines, subdirs } from "../store";

/** Claude Code's transcript JSONL, which Cherry Studio also writes. */
export function parseClaudeCodeSession(file: string, agent = "claude-code"): ParsedSession {
  const builder = new SessionBuilder(agent, path.basename(file, ".jsonl"));
  for (const record of readJsonLines(file)) {
    if (record.type === "ai-title" || record.type === "custom-title") builder.title(record.aiTitle ?? record.customTitle, true);
    if (record.type === "summary") builder.title(record.summary);
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (record.isSidechain || record.isMeta || record.isCompactSummary) continue;
    builder.setCwd(record.cwd).id(record.sessionId).time(record.timestamp);
    const message = asRecord(record.message);
    builder.message(message.role ?? record.type, message.content);
  }
  return builder.build();
}

/** Project folders hold one transcript per session; subagent runs sit one level deeper and are skipped. */
function projectTranscripts(root: string): string[] {
  return subdirs(root).flatMap((project) => listFiles(project, (name) => name.endsWith(".jsonl")));
}

function claudeRoots(ctx: ReaderContext): string[] {
  const config = ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, ".claude");
  return [
    path.join(config, "projects"),
    path.join(ctx.home, "Library", "Developer", "Xcode", "CodingAssistant", "ClaudeAgentConfig", "projects"),
  ];
}

export const claudeCodeReader: SessionReader = {
  id: "claude-code",
  label: "Claude Code",
  find: (ctx) => fileRefs("claude-code", claudeRoots(ctx).flatMap(projectTranscripts), (file) => parseClaudeCodeSession(file)),
};

export const cherryStudioReader: SessionReader = {
  id: "cherrystudio",
  label: "Cherry Studio",
  find: (ctx) => {
    const roots = appConfigDirs(ctx, "CherryStudio").flatMap((dir) => [
      path.join(dir, "Data", "Agents", ".claude", "projects"),
      path.join(dir, ".claude", "projects"),
    ]);
    return fileRefs("cherrystudio", roots.flatMap(projectTranscripts), (file) => parseClaudeCodeSession(file, "cherrystudio"));
  },
};

/** Qwen Code: Claude's envelope around Gemini's `parts`. */
export function parseQwenSession(file: string): ParsedSession {
  const builder = new SessionBuilder("qwen", path.basename(file, ".jsonl"));
  for (const record of readJsonLines(file)) {
    if (record.type !== "user" && record.type !== "assistant") continue;
    builder.setCwd(record.cwd).id(record.sessionId).time(record.timestamp);
    const message = asRecord(record.message);
    builder.message(message.role ?? record.type, message.parts ?? message.content);
  }
  return builder.build();
}

export const qwenReader: SessionReader = {
  id: "qwen",
  label: "Qwen Code",
  find: (ctx) => {
    const root = path.join(ctx.env.QWEN_HOME || path.join(ctx.home, ".qwen"), "projects");
    const files = subdirs(root).flatMap((project) => listFiles(path.join(project, "chats"), (name) => name.endsWith(".jsonl")));
    return fileRefs("qwen", files, parseQwenSession);
  },
};

/** CodeBuddy and WorkBuddy: Claude's folder layout with OpenAI Responses-style items. */
export function parseCodeBuddySession(file: string): ParsedSession {
  const builder = new SessionBuilder("codebuddy", path.basename(file, ".jsonl"));
  for (const record of readJsonLines(file)) {
    builder.setCwd(record.cwd).id(record.sessionId).time(record.timestamp);
    if (record.type === "ai-title" || record.type === "custom-title") builder.title(record.title ?? record.aiTitle ?? record.customTitle);
    const provider = asRecord(record.providerData);
    if (provider.skipRun || record.isMeta || record.isCompactInternal || record.isCompacted || record.isSummary || record.teammateMessage) continue;
    if (record.type === "message") builder.message(record.role, record.content);
    if (record.type === "function_call") builder.tool(String(record.name ?? ""), record.arguments, asString(record.callId) ?? asString(record.call_id));
    if (record.type === "function_call_result" || record.type === "function_call_output") {
      const output = record.output;
      builder.result(asString(record.callId) ?? asString(record.call_id), { error: record.status === "failed", text: typeof output === "string" ? output : String(asRecord(output).text ?? "") });
    }
  }
  return builder.build();
}

export const codeBuddyReader: SessionReader = {
  id: "codebuddy",
  label: "CodeBuddy",
  find: (ctx) => {
    const roots = [
      path.join(ctx.env.CODEBUDDY_CONFIG_DIR || path.join(ctx.home, ".codebuddy"), "projects"),
      path.join(ctx.env.WORKBUDDY_CONFIG_DIR || path.join(ctx.home, ".workbuddy"), "projects"),
      path.join(ctx.home, ".workbuddy-ai", "projects"),
    ];
    return fileRefs("codebuddy", roots.flatMap(projectTranscripts), parseCodeBuddySession);
  },
};
