import fs from "node:fs";
import path from "node:path";
import { stripRulesBlock } from "../init/clients";

export type ImportSourceKind =
  | "obsidian"
  | "markdown"
  | "claude-md"
  | "agents-md"
  | "gemini-md"
  | "cursor-rules"
  | "windsurf-rules"
  | "copilot-instructions"
  | "stdin";

export type ImportFile = {
  /** Stable identity for idempotent re-import (absolute path, or stdin:<hash>). */
  path: string;
  /** Display name and fallback title. */
  name: string;
  source: ImportSourceKind;
  /** Folder relative to the import root, for a category. */
  folder: string | null;
  text: string;
};

const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules", ".make0", ".DS_Store"]);
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdc", ".txt"]);
const RULE_FILE_NAMES = new Set([".windsurfrules", ".cursorrules"]);
const AGENT_SOURCES = new Set<ImportSourceKind>([
  "claude-md",
  "agents-md",
  "gemini-md",
  "cursor-rules",
  "windsurf-rules",
  "copilot-instructions",
]);

export function isAgentSource(source: ImportSourceKind): boolean {
  return AGENT_SOURCES.has(source);
}

/** Classify a file by name and location. */
export function sourceKindFor(filePath: string, inVault: boolean): ImportSourceKind {
  const base = path.basename(filePath);
  const normalized = filePath.split(path.sep).join("/");
  if (base === "CLAUDE.md" || base === "CLAUDE.local.md") return "claude-md";
  if (base === "AGENTS.md") return "agents-md";
  if (base === "GEMINI.md") return "gemini-md";
  if (normalized.includes("/.cursor/rules/") || base === ".cursorrules") return "cursor-rules";
  if (base === ".windsurfrules" || normalized.endsWith("/windsurf/memories/global_rules.md")) return "windsurf-rules";
  if (normalized.endsWith("/.github/copilot-instructions.md")) return "copilot-instructions";
  return inVault ? "obsidian" : "markdown";
}

function isImportable(filePath: string): boolean {
  const base = path.basename(filePath);
  return RULE_FILE_NAMES.has(base) || TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function readImportFile(absolute: string, root: string | null, inVault: boolean): ImportFile {
  const source = sourceKindFor(absolute, inVault);
  const raw = fs.readFileSync(absolute, "utf8");
  const folder = root ? path.relative(root, path.dirname(absolute)) : "";
  return {
    path: absolute,
    name: path.basename(absolute).replace(/\.(md|markdown|mdc|txt)$/i, ""),
    source,
    folder: folder && folder !== "." ? folder.split(path.sep).join("/") : null,
    // Never re-import our own "search Brain first" rule as a memory.
    text: isAgentSource(source) ? stripRulesBlock(raw) : raw,
  };
}

/** A file, or every text file under a folder. A folder with `.obsidian/` is a vault. */
export function collectImportFiles(target: string): ImportFile[] {
  const absolute = path.resolve(target);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [readImportFile(absolute, null, false)];

  const inVault = fs.existsSync(path.join(absolute, ".obsidian"));
  const files: ImportFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Rule folders like .cursor/rules are hidden but wanted.
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isImportable(full)) files.push(readImportFile(full, absolute, inVault));
    }
  };
  walk(absolute);
  return files;
}

/** Agent rule files the user already wrote: global ones under home, project ones under cwd. */
export function detectAgentFiles(home: string, cwd: string): string[] {
  const candidates = [
    path.join(home, ".claude", "CLAUDE.md"),
    path.join(home, ".codex", "AGENTS.md"),
    path.join(home, ".gemini", "GEMINI.md"),
    path.join(home, ".codeium", "windsurf", "memories", "global_rules.md"),
    path.join(cwd, "CLAUDE.md"),
    path.join(cwd, "CLAUDE.local.md"),
    path.join(cwd, "AGENTS.md"),
    path.join(cwd, "GEMINI.md"),
    path.join(cwd, ".windsurfrules"),
    path.join(cwd, ".cursorrules"),
    path.join(cwd, ".github", "copilot-instructions.md"),
  ];
  const cursorRules = path.join(cwd, ".cursor", "rules");
  if (fs.existsSync(cursorRules) && fs.statSync(cursorRules).isDirectory()) {
    for (const entry of fs.readdirSync(cursorRules).sort()) candidates.push(path.join(cursorRules, entry));
  }
  return [...new Set(candidates)].filter((file) => fs.existsSync(file) && fs.statSync(file).isFile() && isImportable(file));
}
