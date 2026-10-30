import fs from "node:fs";
import path from "node:path";

export const SERVER_NAME = "make0-brain";

/** Same instruction text Make0 cloud gives MCP clients. */
export const MAKE0_SYSTEM_INSTRUCTION =
  "Make0 Brain is my source of truth for durable memory. Always search it before answering about me, my work, people, preferences, or past decisions. Save lasting facts and decisions to Brain. Never guess or invent memories. Use Brain exclusively for durable memory.";

const RULES_BEGIN = "<!-- make0-brain:begin -->";
const RULES_END = "<!-- make0-brain:end -->";

export type InitEnv = {
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows. */
  appData?: string;
};

export type StdioServer = { command: string; args: string[] };

/** npx needs a shell shim on Windows. */
export function stdioServer(platform: NodeJS.Platform): StdioServer {
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", "@make0-ai/brain"] }
    : { command: "npx", args: ["-y", "@make0-ai/brain"] };
}

type ConfigFormat = "mcpServers" | "vscode" | "codex-toml" | "hermes-yaml" | "openclaw";

export type McpClient = {
  id: string;
  name: string;
  /** Present when this folder exists, so the client is installed. */
  detectPath: (env: InitEnv) => string;
  configPath: (env: InitEnv) => string;
  format: ConfigFormat;
  /** File-based global rules the client loads every session. */
  rulesPath?: (env: InitEnv) => string;
  /** Where to paste the rule when there is no file. */
  rulesHint?: string;
};

function appSupport(env: InitEnv, ...parts: string[]): string {
  if (env.platform === "darwin") return path.join(env.home, "Library", "Application Support", ...parts);
  if (env.platform === "win32") return path.join(env.appData ?? path.join(env.home, "AppData", "Roaming"), ...parts);
  return path.join(env.home, ".config", ...parts);
}

export const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    detectPath: (env) => path.join(env.home, ".claude"),
    configPath: (env) => path.join(env.home, ".claude.json"),
    format: "mcpServers",
    rulesPath: (env) => path.join(env.home, ".claude", "CLAUDE.md"),
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    detectPath: (env) => appSupport(env, "Claude"),
    configPath: (env) => path.join(appSupport(env, "Claude"), "claude_desktop_config.json"),
    format: "mcpServers",
    rulesHint: "Claude Desktop → Settings → Profile → personal preferences",
  },
  {
    id: "cursor",
    name: "Cursor",
    detectPath: (env) => path.join(env.home, ".cursor"),
    configPath: (env) => path.join(env.home, ".cursor", "mcp.json"),
    format: "mcpServers",
    rulesHint: "Cursor → Settings → Rules → User Rules",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    detectPath: (env) => path.join(env.home, ".codeium", "windsurf"),
    configPath: (env) => path.join(env.home, ".codeium", "windsurf", "mcp_config.json"),
    format: "mcpServers",
    rulesPath: (env) => path.join(env.home, ".codeium", "windsurf", "memories", "global_rules.md"),
  },
  {
    id: "vscode",
    name: "VS Code (Copilot)",
    detectPath: (env) => appSupport(env, "Code", "User"),
    configPath: (env) => path.join(appSupport(env, "Code", "User"), "mcp.json"),
    format: "vscode",
    rulesHint: "VS Code → Copilot instructions (.github/copilot-instructions.md per repo)",
  },
  {
    id: "codex",
    name: "Codex CLI",
    detectPath: (env) => path.join(env.home, ".codex"),
    configPath: (env) => path.join(env.home, ".codex", "config.toml"),
    format: "codex-toml",
    rulesPath: (env) => path.join(env.home, ".codex", "AGENTS.md"),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    detectPath: (env) => path.join(env.home, ".gemini"),
    configPath: (env) => path.join(env.home, ".gemini", "settings.json"),
    format: "mcpServers",
    rulesPath: (env) => path.join(env.home, ".gemini", "GEMINI.md"),
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    detectPath: (env) => path.join(env.home, ".hermes"),
    configPath: (env) => path.join(env.home, ".hermes", "config.yaml"),
    format: "hermes-yaml",
    rulesHint: "Hermes Agent → ~/.hermes/SOUL.md",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    detectPath: (env) => path.join(env.home, ".openclaw"),
    configPath: (env) => path.join(env.home, ".openclaw", "openclaw.json"),
    format: "openclaw",
    rulesHint: "OpenClaw → workspace AGENTS.md (~/.openclaw/workspace/AGENTS.md)",
  },
];

export function detectClients(env: InitEnv, clients = MCP_CLIENTS): McpClient[] {
  return clients.filter((client) => fs.existsSync(client.detectPath(env)));
}

/** True when this app's MCP config already names the Make0 Brain server. */
export function clientConfigIncludesServer(client: McpClient, env: InitEnv): boolean {
  const file = client.configPath(env);
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, "utf8").includes(SERVER_NAME);
}

const CLIENT_ID_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "claude-code", pattern: /claude-code|claude code/ },
  { id: "claude-desktop", pattern: /claude-desktop|claude desktop/ },
  { id: "windsurf", pattern: /windsurf|codeium/ },
  { id: "gemini", pattern: /\bgemini\b/ },
  { id: "hermes", pattern: /\bhermes\b/ },
  { id: "openclaw", pattern: /openclaw/ },
  { id: "codex", pattern: /\bcodex\b/ },
  { id: "cursor", pattern: /\bcursor\b/ },
  { id: "vscode", pattern: /vscode|visual studio code|\bcopilot\b/ },
];

/**
 * Map an MCP `clientInfo` name onto an init client id.
 * Unknown apps get a slug of their own name so grants stay per app.
 */
export function resolveMcpClientId(clientName?: string | null): string {
  const haystack = (clientName ?? "").toLowerCase().trim();
  if (!haystack) return "mcp";
  for (const candidate of CLIENT_ID_PATTERNS) {
    if (candidate.pattern.test(haystack)) return candidate.id;
  }
  const slug = haystack
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "mcp";
}

function readJsonObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export type ConfigChange = {
  file: string;
  status: "added" | "updated" | "unchanged";
  /** New file contents; undefined when unchanged. */
  contents?: string;
};

/** Compute the new config file without touching disk. */
export function planConfigChange(client: McpClient, env: InitEnv, server = stdioServer(env.platform)): ConfigChange {
  const file = client.configPath(env);

  if (client.format === "codex-toml") {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const header = `[mcp_servers.${SERVER_NAME}]`;
    const block = `${header}\ncommand = ${tomlString(server.command)}\nargs = [${server.args.map(tomlString).join(", ")}]\n`;
    if (existing.includes(header)) {
      // Replace the table up to the next header (or end of file).
      const start = existing.indexOf(header);
      const nextHeader = existing.slice(start + header.length).search(/^\[/m);
      const end = nextHeader < 0 ? existing.length : start + header.length + nextHeader;
      const current = existing.slice(start, end);
      if (current.trim() === block.trim()) return { file, status: "unchanged" };
      return { file, status: "updated", contents: `${existing.slice(0, start)}${block}\n${existing.slice(end).replace(/^\n+/, "")}` };
    }
    const separator = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    return { file, status: "added", contents: `${existing}${separator}${block}` };
  }

  if (client.format === "hermes-yaml") {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return planYamlServer(file, existing, server);
  }

  if (client.format === "openclaw") {
    let config: Record<string, unknown>;
    try {
      config = readJsonObject(file);
    } catch {
      // openclaw.json is JSON5; comments or trailing commas need OpenClaw's own CLI.
      throw new Error(`${file} is not plain JSON. Run: openclaw mcp set ${SERVER_NAME} '${JSON.stringify(server)}'`);
    }
    const mcp = objectAt(config, "mcp");
    const servers = objectAt(mcp, "servers");
    const previous = servers[SERVER_NAME];
    if (JSON.stringify(previous) === JSON.stringify(server)) return { file, status: "unchanged" };
    const next = { ...config, mcp: { ...mcp, servers: { ...servers, [SERVER_NAME]: { ...server } } } };
    return { file, status: previous ? "updated" : "added", contents: `${JSON.stringify(next, null, 2)}\n` };
  }

  const config = readJsonObject(file);
  const key = client.format === "vscode" ? "servers" : "mcpServers";
  const servers = objectAt(config, key);
  const entry = client.format === "vscode" ? { type: "stdio", ...server } : { ...server };
  const previous = servers[SERVER_NAME];
  if (JSON.stringify(previous) === JSON.stringify(entry)) return { file, status: "unchanged" };
  const next = { ...config, [key]: { ...servers, [SERVER_NAME]: entry } };
  return { file, status: previous ? "updated" : "added", contents: `${JSON.stringify(next, null, 2)}\n` };
}

/** Add or replace our entry under Hermes' top-level `mcp_servers:` key, leaving the rest of the YAML as written. */
function planYamlServer(file: string, existing: string, server: StdioServer): ConfigChange {
  const lines = existing.split("\n");
  const sectionAt = lines.findIndex((line) => /^mcp_servers:\s*(\{\s*\})?\s*(#.*)?$/.test(line));
  const isChild = (line: string) => line.trim() === "" || line.trim().startsWith("#") || /^\s/.test(line);

  let indent = "  ";
  let sectionEnd = lines.length;
  if (sectionAt >= 0) {
    sectionEnd = sectionAt + 1;
    while (sectionEnd < lines.length && isChild(lines[sectionEnd])) sectionEnd++;
    const firstChild = lines.slice(sectionAt + 1, sectionEnd).find((line) => /^\s+[^\s#]/.test(line));
    if (firstChild) indent = firstChild.match(/^\s+/)![0];
  }
  const entry = [
    `${indent}${SERVER_NAME}:`,
    `${indent}${indent}command: ${JSON.stringify(server.command)}`,
    `${indent}${indent}args: [${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
  ];

  if (sectionAt < 0) {
    const separator = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    return { file, status: "added", contents: `${existing}${separator}mcp_servers:\n${entry.join("\n")}\n` };
  }

  const next = [...lines];
  next[sectionAt] = "mcp_servers:";
  const entryAt = lines.findIndex((line, index) => index > sectionAt && index < sectionEnd && line === `${indent}${SERVER_NAME}:`);
  if (entryAt < 0) {
    next.splice(sectionAt + 1, 0, ...entry);
    return { file, status: "added", contents: next.join("\n") };
  }
  let entryEnd = entryAt + 1;
  while (entryEnd < sectionEnd && (lines[entryEnd].trim() === "" || lines[entryEnd].startsWith(`${indent}${indent}`))) entryEnd++;
  // Keep blank lines that separate us from the next entry.
  while (entryEnd > entryAt + 1 && lines[entryEnd - 1].trim() === "") entryEnd--;
  if (lines.slice(entryAt, entryEnd).join("\n") === entry.join("\n")) return { file, status: "unchanged" };
  next.splice(entryAt, entryEnd - entryAt, ...entry);
  return { file, status: "updated", contents: next.join("\n") };
}

export function rulesBlock(): string {
  return `${RULES_BEGIN}\n## Memory\n\n${MAKE0_SYSTEM_INSTRUCTION}\n${RULES_END}`;
}

/** Remove our block, e.g. before importing a rules file as memories. */
export function stripRulesBlock(text: string): string {
  const pattern = new RegExp(`${RULES_BEGIN}[\\s\\S]*?${RULES_END}\\n?`, "g");
  return text.replace(pattern, "");
}

/** Add or refresh the marked rules block. */
export function planRulesChange(file: string): ConfigChange {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = rulesBlock();
  if (existing.includes(RULES_BEGIN)) {
    const next = existing.replace(new RegExp(`${RULES_BEGIN}[\\s\\S]*?${RULES_END}`), block);
    return next === existing ? { file, status: "unchanged" } : { file, status: "updated", contents: next };
  }
  const separator = existing.trim() ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  return { file, status: "added", contents: `${existing}${separator}${block}\n` };
}

/** Write a planned change, keeping one backup of the previous file. */
export function applyChange(change: ConfigChange): void {
  if (change.contents === undefined) return;
  fs.mkdirSync(path.dirname(change.file), { recursive: true });
  if (fs.existsSync(change.file)) fs.copyFileSync(change.file, `${change.file}.make0-backup`);
  fs.writeFileSync(change.file, change.contents);
}
