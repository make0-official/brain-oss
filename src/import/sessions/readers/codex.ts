import path from "node:path";
import { type ParsedSession, SessionBuilder, asArray, asRecord, asString, exitCodeFrom, firstLine, patchFiles, textOf } from "../session";
import { type ReaderContext, type SessionReader, fileRefs, listFiles, readJsonLines } from "../store";

type Command = { command: string; failed: boolean; error?: string; id?: string };

function shellCommand(name: string, rawArguments: unknown): string | null {
  if (!/^(?:shell|exec_command|local_shell|container\.exec|shell_command)$/.test(name)) return null;
  let args: Record<string, unknown> = {};
  try {
    args = typeof rawArguments === "string" ? asRecord(JSON.parse(rawArguments)) : asRecord(rawArguments);
  } catch {
    return null;
  }
  const command = args.command ?? args.cmd;
  if (Array.isArray(command)) {
    // ["bash", "-lc", "npm test"] → "npm test"
    const shellIndex = command.findIndex((part) => part === "-lc" || part === "-c");
    return (shellIndex >= 0 ? command.slice(shellIndex + 1) : command).map(String).join(" ") || null;
  }
  return asString(command);
}

function outputText(output: unknown): string {
  const text = typeof output === "string" ? output : textOf(output);
  try {
    return String(asRecord(JSON.parse(text)).output ?? text);
  } catch {
    return text;
  }
}

/**
 * Codex rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), which TRAE
 * CLI writes too. What the person typed is the `user_message` event when the
 * rollout has one; `response_item` user messages also carry harness context.
 */
export function parseCodexSession(file: string, agent = "codex"): ParsedSession {
  const builder = new SessionBuilder(agent, path.basename(file, ".jsonl").replace(/^rollout-/, ""));
  const prompts = { event: [] as string[], item: [] as string[], response: [] as string[] };
  const calls: Command[] = [];
  // The desktop app logs commands as items with an exit code; prefer those over the raw calls.
  const executed: Command[] = [];
  const responseItem = (payload: Record<string, unknown>) => {
    // Older rollouts write messages without `type`.
    if (payload.type === "message" || (!payload.type && payload.role)) {
      const text = asArray(payload.content)
        .map((part) => asString(asRecord(part).text) ?? "")
        .join("\n");
      if (payload.role === "user") prompts.response.push(text);
      else if (payload.role === "assistant") builder.reply(text);
      return;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const name = String(payload.name ?? "");
      const input = payload.arguments ?? payload.input;
      if (name === "apply_patch") {
        for (const file of patchFiles(typeof input === "string" ? input : JSON.stringify(input ?? ""))) builder.file(file);
        return;
      }
      const command = shellCommand(name, input);
      if (command) calls.push({ command, failed: false, id: String(payload.call_id ?? "") });
      return;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const command = calls.find((call) => call.id === String(payload.call_id ?? ""));
      const code = command ? exitCodeFrom(payload.output) : null;
      if (command && code !== null && code !== 0) {
        command.failed = true;
        command.error = firstLine(outputText(payload.output).replace(/^(?:Exit code|Wall time)[^\n]*\n/gim, ""));
      }
    }
  };

  for (const record of readJsonLines(file)) {
    builder.time(record.timestamp);
    const payload = asRecord(record.payload);
    if (record.type === "session_meta") {
      builder.id(payload.id ?? payload.session_id).setCwd(payload.cwd);
      continue;
    }
    if (record.type === "turn_context") builder.setCwd(payload.cwd);
    if (record.type === "event_msg") {
      if (payload.type === "user_message") prompts.event.push(String(payload.message ?? ""));
      if (payload.type === "task_complete") builder.reply(payload.last_agent_message);
      if (payload.type === "item_completed") {
        const item = asRecord(payload.item);
        if (item.type === "UserMessage") prompts.item.push(textOf(item.content));
        const command = item.type === "CommandExecution" ? shellCommand("shell", { command: item.command }) : null;
        if (command) {
          const code = typeof item.exit_code === "number" ? item.exit_code : null;
          const failed = code !== null && code !== 0;
          executed.push({ command, failed, error: failed ? firstLine(String(item.aggregated_output ?? "")) : undefined });
        }
      }
    }
    if (record.type === "response_item") responseItem(payload);
    if (record.type === "history_mutation") for (const item of asArray(payload.items)) responseItem(asRecord(item));
  }

  const typed = prompts.event.length ? prompts.event : prompts.item.length ? prompts.item : prompts.response;
  for (const prompt of typed) builder.prompt(prompt);
  for (const command of executed.length ? executed : calls) builder.command(command.command, null, command);
  return builder.build();
}

function rolloutFiles(root: string): string[] {
  return listFiles(root, (name) => name.endsWith(".jsonl"), { depth: 4 });
}

function codexRoots(ctx: ReaderContext): string[] {
  const home = ctx.env.CODEX_HOME || path.join(ctx.home, ".codex");
  return [
    path.join(home, "sessions"),
    path.join(home, "archived_sessions"),
    path.join(ctx.home, "Library", "Developer", "Xcode", "CodingAssistant", "codex", "sessions"),
  ];
}

export const codexReader: SessionReader = {
  id: "codex",
  label: "Codex",
  find: (ctx) => fileRefs("codex", codexRoots(ctx).flatMap(rolloutFiles), (file) => parseCodexSession(file)),
};

export const traeReader: SessionReader = {
  id: "trae",
  label: "TRAE CLI",
  find: (ctx) => {
    const cli = ctx.env.TRAECLI_HOME || path.join(ctx.env.TRAE_HOME || path.join(ctx.home, ".trae"), "cli");
    const files = [path.join(cli, "sessions"), path.join(cli, "archived_sessions")].flatMap(rolloutFiles);
    return fileRefs("trae", files, (file) => parseCodexSession(file, "trae"));
  },
};
