import path from "node:path";

export type SessionCommand = { command: string; failed: boolean; error?: string };

/** One coding-agent session, reduced to what a digest needs. */
export type ParsedSession = {
  agent: string;
  id: string;
  title: string | null;
  cwd: string | null;
  /** A project name when the store has one but no working directory. */
  project?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  prompts: string[];
  filesChanged: string[];
  commands: SessionCommand[];
  outcome: string | null;
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A JSON string or an object, as tools pass their arguments. */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

/** Epoch seconds, milliseconds or microseconds, a numeric string, or a date string → ISO, or null. */
export function toIso(value: unknown): string | null {
  let input = value;
  if (typeof input === "string" && /^\d+(?:\.\d+)?$/.test(input.trim())) input = Number(input);
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    const ms = input < 1e11 ? input * 1000 : input < 1e14 ? input : input / 1000;
    return new Date(ms).toISOString();
  }
  if (typeof input === "string" && input.trim()) {
    const parsed = Date.parse(input.trim().replace(" ", "T"));
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

/** `file:///Users/me/x%20y` → `/Users/me/x y`. */
export function fromFileUri(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  if (!text.startsWith("file://")) return text;
  try {
    return decodeURIComponent(new URL(text).pathname);
  } catch {
    return text.replace(/^file:\/\//, "");
  }
}

const WORKTREE_PATH = /^(.*?)\/\.claude\/worktrees\/[^/]+/;

/** A Claude Code worktree (`…/.claude/worktrees/<name>/…`) belongs to its repository. */
export function withoutWorktree(file: string): string {
  return file.split(path.sep).join("/").replace(WORKTREE_PATH, "$1");
}

/** Scratch files outside the project say nothing about it later. */
const TEMP_PATH = /^(?:\/private)?\/tmp\/|^\/var\/folders\/|^\/mnt\/data\/|\/scratchpad\//;

/** Wrappers harnesses put around what the person typed; the inside is kept. */
const UNWRAP_TAGS = ["task", "USER_REQUEST", "user_query", "user_request", "feedback", "answer"];
/** Blocks harnesses add to a user turn; dropped whole. */
const DROP_BLOCKS = [
  "system-reminder",
  "environment_details",
  "environment_context",
  "ADDITIONAL_METADATA",
  "USER_SETTINGS_CHANGE",
  "timestamp",
  "user_info",
  "additional_data",
  "attached_files",
  "agent-context",
];

/** Harness-injected turns (`<command-name>`, `<local-command-stdout>`, …) are not the person. */
function isInjected(text: string): boolean {
  return (
    text.startsWith("<") ||
    text.startsWith("Caveat:") ||
    text.startsWith("[Request interrupted") ||
    text.startsWith("## Referenced ") ||
    text.startsWith("## Conversation Summary") ||
    text.startsWith("This session is being continued from a previous conversation")
  );
}

export function cleanUserText(raw: string): string | null {
  let text = raw.replace(/\r\n/g, "\n");
  for (const tag of DROP_BLOCKS) text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"), "");
  text = text.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, "");
  for (const tag of UNWRAP_TAGS) text = text.replace(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"), "$1");
  text = text.replace(/\[Image[^\]]*\]/g, "").trim();
  return text && !isInjected(text) ? text : null;
}

const COMMAND_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "powershell",
  "pwsh",
  "run_shell_command",
  "shell_command",
  "run_terminal_command",
  "run_terminal_cmd",
  "runterminalcommand",
  "run_command",
  "runcommand",
  "execute_command",
  "executecommand",
  "exec_command",
  "exec",
  "local_shell",
  "terminal",
  "task_shell_start",
  "monitor_command",
  "run_commands",
  "execute_bash",
  "bash_tool",
]);
const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "multi_edit",
  "write",
  "create",
  "create_file",
  "write_file",
  "edit_file",
  "replace",
  "replace_in_file",
  "write_to_file",
  "apply_diff",
  "insert_content",
  "search_and_replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "strreplace",
  "str_replace",
  "search_replace",
  "edit_existing_file",
  "create_new_file",
  "notebookedit",
  "notebook_edit",
  "fs_write",
  "text_editor",
  "editor",
  "delete_file",
  "fim_edit",
  "write_new_file",
  "apply_edit",
  "editfile",
  "writefile",
  "createfile",
]);
const PATCH_TOOLS = new Set(["apply_patch", "patch", "applypatch"]);
const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "filepath",
  "file",
  "target_file",
  "targetFile",
  "TargetFile",
  "AbsolutePath",
  "absolute_path",
  "notebook_path",
  "uri",
];

/** `developer__shell` → `shell`, `mcp__x__Bash` → `bash`, `terminal/run` → `run`. */
function baseToolName(name: string): string {
  const last = name.split(/__|\/|\.|:/).filter(Boolean).pop() ?? name;
  return last.toLowerCase();
}

function commandFromInput(input: Record<string, unknown>): string | null {
  const raw = input.command ?? input.cmd ?? input.CommandLine ?? input.commandLine ?? input.command_line;
  if (Array.isArray(raw)) {
    // ["bash", "-lc", "npm test"] → "npm test"
    const shellIndex = raw.findIndex((part) => part === "-lc" || part === "-c");
    return (shellIndex >= 0 ? raw.slice(shellIndex + 1) : raw).map(String).join(" ") || null;
  }
  const command = asString(raw);
  if (command) {
    const args = asArray(input.args).map(String);
    return args.length ? `${command} ${args.join(" ")}` : command;
  }
  const commands = asArray(input.commands)
    .map((entry) => asString(entry) ?? asString(asRecord(entry).command))
    .filter((entry): entry is string => Boolean(entry));
  return commands.length ? commands.join(" && ") : null;
}

/** Files a patch names: codex's `*** Update File:` headers and unified `+++ b/` headers. */
export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$|^\+\+\+ (?:b\/)?(.+)$/gm)) {
    const file = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (file && file !== "/dev/null") files.push(file);
  }
  return files;
}

const EXIT_CODE_PATTERN =
  /(?:exit(?:ed)?(?: with)?(?: status| code)|exit_code|Exit code|exitCode)["']?\s*[:=]?\s*(-?\d+)/i;

/** An exit code from a tool's output: JSON metadata, or a trailer like "Exit code: 1". */
export function exitCodeFrom(output: unknown): number | null {
  const parsed = parseMaybeJson(output);
  const record = asRecord(parsed);
  const candidates = [
    asRecord(record.metadata).exit_code,
    asRecord(record.metadata).exit,
    record.exit_code,
    record.exitCode,
    asRecord(record.exit).exit_code,
  ];
  for (const candidate of candidates) if (typeof candidate === "number") return candidate;
  const text = typeof output === "string" ? output : textOf(output);
  const match = text.match(EXIT_CODE_PATTERN);
  return match ? Number(match[1]) : null;
}

/** Text out of a string, a block list, `{text}`, `{output}` or `{content}`. */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  const record = asRecord(value);
  for (const key of ["text", "output", "content", "result", "value", "data", "error", "stdout"]) {
    if (key in record) {
      const text = textOf(record[key]);
      if (text) return text;
    }
  }
  return "";
}

/** The first line worth showing from a failed command's output, framing lines skipped. */
function errorLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:Exit code|Wall time|Output from command|Command output|Process exited|Chunk ID|Original token count|Output:)/i.test(line));
  return lines[0] ?? "";
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown; id: string | null }
  | { kind: "result"; id: string | null; error: boolean; text: string; exitCode: number | null };

const SKIP_PART_TYPES = new Set(["thinking", "reasoning", "redacted_thinking", "image", "image_url", "think", "input_image", "file"]);

/** Content in any of the shapes agents write: a string, Anthropic blocks, OpenAI parts, Gemini parts. */
export function contentParts(content: unknown): Part[] {
  if (typeof content === "string") return content.trim() ? [{ kind: "text", text: content }] : [];
  const parts: Part[] = [];
  for (const item of Array.isArray(content) ? content : content && typeof content === "object" ? [content] : []) {
    if (typeof item === "string") {
      if (item.trim()) parts.push({ kind: "text", text: item });
      continue;
    }
    const part = asRecord(item);
    const type = String(part.type ?? part.kind ?? "");
    if (SKIP_PART_TYPES.has(type)) continue;
    const call = asRecord(part.functionCall ?? part.function_call);
    if (Object.keys(call).length) {
      parts.push({ kind: "tool", name: String(call.name ?? ""), input: call.args ?? call.arguments, id: asString(call.id) });
      continue;
    }
    const response = asRecord(part.functionResponse ?? part.function_response);
    if (Object.keys(response).length) {
      const output = response.response ?? response.output;
      parts.push({ kind: "result", id: asString(response.id), error: Boolean(asRecord(output).error), text: textOf(output), exitCode: exitCodeFrom(output) });
      continue;
    }
    if (/^(?:tool_use|toolCall|tool-call|tool_call|function_call|server_tool_use|ToolUse)$/.test(type)) {
      parts.push({
        kind: "tool",
        name: String(part.name ?? part.toolName ?? asRecord(part.function).name ?? ""),
        input: part.input ?? part.arguments ?? part.args ?? asRecord(part.function).arguments,
        id: asString(part.id) ?? asString(part.toolCallId) ?? asString(part.call_id) ?? asString(part.callId),
      });
      continue;
    }
    if (/^(?:tool_result|toolResult|tool-result|function_call_output|function_call_result)$/.test(type)) {
      const output = part.content ?? part.output ?? part.result;
      parts.push({
        kind: "result",
        id: asString(part.tool_use_id) ?? asString(part.toolCallId) ?? asString(part.call_id) ?? asString(part.callId) ?? asString(part.id),
        error: Boolean(part.is_error ?? part.isError),
        text: textOf(output),
        exitCode: exitCodeFrom(output),
      });
      continue;
    }
    const text = asString(part.text) ?? (type === "text" ? asString(part.data) ?? asString(asRecord(part.data).text) : null);
    if (text && (!type || /^(?:text|input_text|output_text|Text|markdown)$/.test(type))) parts.push({ kind: "text", text });
  }
  return parts;
}

const USER_ROLES = new Set(["user", "human", "prompt"]);
const ASSISTANT_ROLES = new Set(["assistant", "model", "gemini", "ai", "agent", "bot", "copilot"]);
const TOOL_ROLES = new Set(["tool", "toolresult", "tool_result", "function", "ipython"]);

/**
 * Collects one session from whatever records a reader walks. Readers call
 * `message` for ordinary role/content turns and the narrower methods for
 * stores with their own event shapes.
 */
export class SessionBuilder {
  private readonly session: ParsedSession;
  private readonly calls = new Map<string, SessionCommand>();
  private readonly files: string[] = [];
  private startMs = Number.POSITIVE_INFINITY;
  private endMs = Number.NEGATIVE_INFINITY;

  constructor(agent: string, id: string) {
    this.session = {
      agent,
      id,
      title: null,
      cwd: null,
      startedAt: null,
      endedAt: null,
      prompts: [],
      filesChanged: [],
      commands: [],
      outcome: null,
    };
  }

  get cwd(): string | null {
    return this.session.cwd;
  }

  get promptCount(): number {
    return this.session.prompts.length;
  }

  id(value: unknown): this {
    const id = asString(value) ?? (typeof value === "number" ? String(value) : null);
    if (id) this.session.id = id;
    return this;
  }

  /** First working directory wins unless `force`. */
  setCwd(value: unknown, force = false): this {
    const cwd = fromFileUri(value);
    if (cwd && (force || !this.session.cwd)) this.session.cwd = cwd.replace(/\/+$/, "") || cwd;
    return this;
  }

  title(value: unknown, force = false): this {
    const title = asString(value)?.trim();
    if (title && (force || !this.session.title)) this.session.title = title;
    return this;
  }

  project(value: unknown): this {
    const project = asString(value);
    if (project) this.session.project = project;
    return this;
  }

  time(value: unknown): this {
    const iso = toIso(value);
    if (!iso) return this;
    const ms = Date.parse(iso);
    this.startMs = Math.min(this.startMs, ms);
    this.endMs = Math.max(this.endMs, ms);
    return this;
  }

  prompt(raw: unknown): this {
    const text = typeof raw === "string" ? cleanUserText(raw) : null;
    if (text) this.session.prompts.push(text);
    return this;
  }

  /** The newest assistant text is how the session ended. */
  reply(raw: unknown): this {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text) this.session.outcome = text;
    return this;
  }

  file(value: unknown): this {
    const file = fromFileUri(value)?.trim();
    if (file) this.files.push(file);
    return this;
  }

  command(text: string, id?: string | null, result?: { failed?: boolean; error?: string }): SessionCommand {
    const command: SessionCommand = { command: text.trim(), failed: Boolean(result?.failed) };
    if (result?.error) command.error = result.error;
    this.session.commands.push(command);
    if (id) this.calls.set(id, command);
    return command;
  }

  /** A tool call: shell tools become commands, editing tools name their files. */
  tool(name: string, rawInput: unknown, id?: string | null): this {
    const base = baseToolName(name);
    const parsed = parseMaybeJson(rawInput);
    const input = asRecord(parsed);
    if (PATCH_TOOLS.has(base)) {
      const patch =
        typeof parsed === "string"
          ? parsed
          : String(input.input ?? input.patch ?? input.patchText ?? input.patch_text ?? input.diff ?? "");
      for (const file of patchFiles(patch)) this.file(file);
      if (typeof input.path === "string") this.file(input.path);
      return this;
    }
    if (COMMAND_TOOLS.has(base)) {
      const command = commandFromInput(input) ?? (typeof parsed === "string" ? asString(parsed) : null);
      if (command) this.command(command, id ?? null);
      return this;
    }
    if (EDIT_TOOLS.has(base)) {
      if ((base === "text_editor" || base === "str_replace_editor" || base === "editor") && input.command === "view") return this;
      for (const key of PATH_KEYS) {
        if (typeof input[key] === "string") {
          this.file(input[key]);
          break;
        }
      }
      for (const edit of asArray(input.edits)) {
        const file = asString(asRecord(edit).path) ?? asString(asRecord(edit).file_path);
        if (file) this.file(file);
      }
    }
    return this;
  }

  /** A tool's result; marks its command failed on an error or a non-zero exit code. */
  result(id: string | null | undefined, outcome: { error?: boolean; text?: string; exitCode?: number | null }): this {
    const command = id ? this.calls.get(id) : undefined;
    if (!command) return this;
    const raw = outcome.text ?? "";
    const parsed = parseMaybeJson(raw);
    const text = parsed !== raw && typeof parsed === "object" ? textOf(parsed) || raw : raw;
    const exitCode = outcome.exitCode ?? exitCodeFrom(raw);
    if (exitCode === -1 && !outcome.error) return this;
    if (outcome.error || (exitCode !== null && exitCode !== 0)) {
      command.failed = true;
      const line = errorLine(text);
      if (line) command.error = line;
    }
    return this;
  }

  /**
   * One conversational turn in any common shape. `toolCalls` is OpenAI's
   * `tool_calls`; `toolCallId` and `isError` belong to a tool-role message.
   */
  message(
    role: unknown,
    content: unknown,
    extra: { toolCalls?: unknown; toolCallId?: unknown; isError?: unknown; exitCode?: number | null } = {},
  ): this {
    const normalized = String(role ?? "").toLowerCase();
    const parts = contentParts(content);
    if (USER_ROLES.has(normalized)) {
      const text = parts.filter((part) => part.kind === "text").map((part) => (part as { text: string }).text);
      if (text.length) this.prompt(text.join("\n"));
    } else if (ASSISTANT_ROLES.has(normalized)) {
      const text = parts.filter((part) => part.kind === "text").map((part) => (part as { text: string }).text);
      if (text.length) this.reply(text.join("\n"));
      for (const call of asArray(extra.toolCalls)) {
        const record = asRecord(call);
        const fn = asRecord(record.function);
        this.tool(String(fn.name ?? record.name ?? ""), fn.arguments ?? record.arguments ?? record.args ?? record.input, asString(record.id));
      }
    } else if (TOOL_ROLES.has(normalized)) {
      this.result(asString(extra.toolCallId), {
        error: Boolean(extra.isError),
        text: parts.map((part) => (part.kind === "text" ? part.text : part.kind === "result" ? part.text : "")).join("\n") || textOf(content),
        exitCode: extra.exitCode ?? null,
      });
      return this;
    }
    for (const part of parts) {
      if (part.kind === "tool") this.tool(part.name, part.input, part.id);
      if (part.kind === "result") this.result(part.id, part);
    }
    return this;
  }

  build(): ParsedSession {
    const session = { ...this.session };
    if (Number.isFinite(this.startMs)) session.startedAt = new Date(this.startMs).toISOString();
    if (Number.isFinite(this.endMs)) session.endedAt = new Date(this.endMs).toISOString();
    const seen = new Set<string>();
    session.filesChanged = [];
    for (const file of this.files) {
      const absolute = withoutWorktree(session.cwd && !path.isAbsolute(file) ? path.join(session.cwd, file) : file);
      const insideProject = session.cwd != null && absolute.startsWith(`${session.cwd}/`);
      if ((!insideProject && TEMP_PATH.test(absolute)) || seen.has(absolute)) continue;
      seen.add(absolute);
      session.filesChanged.push(absolute);
    }
    return session;
  }
}
