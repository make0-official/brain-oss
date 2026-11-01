import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import type { ParsedSession } from "./session";

export type ReaderContext = {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Epoch ms; stores that can filter by time in SQL skip older sessions before reading them. */
  since?: number;
  /** Runs once every session has been loaded (closes databases). */
  defer: (cleanup: () => void) => void;
  /** A store that could not be read; reported, never fatal. */
  warn: (message: string) => void;
};

/** One session found on disk; `load` reads it only if it passes the filters. */
export type SessionRef = {
  agent: string;
  /** Stable identity for re-import: the file, or `<database>#<session id>`. */
  path: string;
  /** Last activity, for `--since`. */
  mtimeMs: number;
  load: () => ParsedSession | ParsedSession[] | null;
};

export type SessionReader = {
  id: string;
  label: string;
  find: (ctx: ReaderContext) => SessionRef[];
};

export function exists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function isDir(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Entries of a directory, or none when it is missing or unreadable. */
export function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Files under `root` matching `match`, at most `depth` directories down; `skipDir` prunes. */
export function listFiles(
  root: string,
  match: (name: string, full: string) => boolean,
  options: { depth?: number; skipDir?: (name: string, full: string) => boolean } = {},
): string[] {
  const depth = options.depth ?? 0;
  const files: string[] = [];
  for (const entry of readDir(root)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !options.skipDir?.(entry.name, full)) files.push(...listFiles(full, match, { ...options, depth: depth - 1 }));
    } else if (entry.isFile() && match(entry.name, full)) {
      files.push(full);
    }
  }
  return files;
}

/** Subdirectories of `root` (full paths). */
export function subdirs(root: string): string[] {
  return readDir(root)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readJson(file: string): unknown {
  const text = readText(file);
  if (text == null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as Record<string, unknown>);
    } catch {
      // A session still being written can end in a partial line.
    }
  }
  return records;
}

export function readJsonLines(file: string): Array<Record<string, unknown>> {
  const text = readText(file);
  return text == null ? [] : parseJsonLines(text);
}

/** zstd frames: Node's own decoder where it has one (22.15+), else the `zstd` CLI, else null. */
export function zstdDecompress(data: Buffer): Buffer | null {
  const native = (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync;
  try {
    if (native) return native(data);
  } catch {
    return null;
  }
  const result = spawnSync("zstd", ["-dcq"], { input: data, maxBuffer: 512 * 1024 * 1024 });
  return result.status === 0 && result.stdout ? result.stdout : null;
}

/** Read-only SQLite; null when the file is missing, locked or not a database. */
export function openSqlite(file: string, ctx: ReaderContext): Database.Database | null {
  if (!exists(file)) return null;
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    ctx.defer(() => db.close());
    return db;
  } catch (error) {
    ctx.warn(`Could not open ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

export function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`pragma table_info("${table.replace(/"/g, "")}")`).all() as Array<{ name: string }>).map((row) => row.name));
}

/** `~/Library/Application Support/<name>`, `%APPDATA%\<name>`, or `$XDG_CONFIG_HOME/<name>`. */
export function appConfigDirs(ctx: ReaderContext, name: string): string[] {
  if (ctx.platform === "darwin") return [path.join(ctx.home, "Library", "Application Support", name)];
  if (ctx.platform === "win32") return ctx.env.APPDATA ? [path.join(ctx.env.APPDATA, name)] : [];
  return [path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, ".config"), name)];
}

/** `$XDG_DATA_HOME/<name>`, default `~/.local/share/<name>`, on every OS (how these CLIs resolve it). */
export function xdgDataDir(ctx: ReaderContext, name: string): string {
  return path.join(ctx.env.XDG_DATA_HOME || path.join(ctx.home, ".local", "share"), name);
}

const VSCODE_HOSTS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf", "Kiro", "Trae"];

/** Each installed VS Code-family editor's `User` folder. */
export function vscodeUserDirs(ctx: ReaderContext, hosts: string[] = VSCODE_HOSTS): string[] {
  return hosts.flatMap((host) => appConfigDirs(ctx, host).map((dir) => path.join(dir, "User"))).filter(isDir);
}

/**
 * Claude Code–style project folders name a path with `/` (and `.`, `_`, spaces)
 * turned into `-`, which loses information. Walk the disk to find the real
 * directory; fall back to null when nothing matches.
 */
export function decodeProjectDir(encoded: string, root = "/"): string | null {
  const walk = (dir: string, rest: string, depth: number): string | null => {
    if (!rest) return dir;
    if (depth > 24) return null;
    for (const entry of readDir(dir)) {
      if (!entry.isDirectory()) continue;
      const normalized = entry.name.replace(/[^A-Za-z0-9]/g, "-");
      if (rest === normalized) return path.join(dir, entry.name);
      if (rest.startsWith(`${normalized}-`)) {
        const resolved = walk(path.join(dir, entry.name), rest.slice(normalized.length + 1), depth + 1);
        if (resolved) return resolved;
      }
    }
    return null;
  };
  const target = encoded.replace(/^-/, "").replace(/-+$/, "");
  return target ? walk(root, target, 0) : null;
}

/** Per-file sessions: one ref per file, loaded by `parse`. */
export function fileRefs(agent: string, files: string[], parse: (file: string) => ParsedSession | ParsedSession[] | null): SessionRef[] {
  return files.map((file) => ({ agent, path: file, mtimeMs: mtimeMs(file), load: () => parse(file) }));
}
