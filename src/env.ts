import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Env = Record<string, string | undefined>;

/** `KEY=value` lines, `#` comments, optional quotes, and an optional `export ` prefix. */
export function parseEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (value !== "") parsed[match[1]] = value;
  }
  return parsed;
}

/** Fill keys that are missing or blank. Existing values stay. */
export function applyEnv(parsed: Record<string, string>, env: Env): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] == null || env[key] === "") env[key] = value;
  }
}

function applyEnvFile(file: string, env: Env): void {
  if (!fs.existsSync(file)) return;
  applyEnv(parseEnvFile(fs.readFileSync(file, "utf8")), env);
}

/**
 * Load Make0 Brain settings into `env`.
 *
 * Already-set variables win. Then `./.env`, then `.env` in the data folder
 * (`MAKE0_BRAIN_HOME`, default `~/.make0`). A `MAKE0_BRAIN_HOME` set in
 * `./.env` selects that data folder before its `.env` is read.
 */
export function loadEnvFiles(
  options: { env?: Env; cwd?: string; homeDir?: string } = {},
): void {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const cwdFile = path.join(cwd, ".env");
  applyEnvFile(cwdFile, env);
  const dataHome = env.MAKE0_BRAIN_HOME?.trim() || path.join(homeDir, ".make0");
  const dataFile = path.join(dataHome, ".env");
  if (path.resolve(dataFile) !== path.resolve(cwdFile)) applyEnvFile(dataFile, env);
}
