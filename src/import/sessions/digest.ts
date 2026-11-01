import path from "node:path";
import { MEMORY_CONTENT_MAX_CHARS } from "../../shared/limits";
import { type ParsedSession, withoutWorktree } from "./session";

const DIGEST_MAX_CHARS = MEMORY_CONTENT_MAX_CHARS - 100;
const PROMPT_MAX_CHARS = 400;
const MAX_PROMPTS = 8;
const MAX_FILES = 25;
const MAX_FAILED_COMMANDS = 8;
const OUTCOME_MAX_CHARS = 900;
/** User turns that steer the agent; they are the most reusable part of a session. */
const CORRECTION_PATTERN =
  /^(?:no\b|nope\b|don'?t\b|do not\b|never\b|always\b|stop\b|instead\b|actually\b|wrong\b|that'?s not\b|use \S+ (?:instead|not)\b|please (?:don'?t|always|never)\b)/i;

const SECRET_PATTERNS: Array<[kind: string, pattern: RegExp]> = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g],
  ["anthropic-key", /\bsk-ant-[\w-]{16,}/g],
  ["openrouter-key", /\bsk-or-[\w-]{16,}/g],
  ["openai-key", /\bsk-(?:proj-)?[\w-]{20,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[\w]{20,})/g],
  ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["slack-token", /\bxox[abprs]-[\w-]{10,}/g],
  ["google-key", /\bAIza[\w-]{30,}/g],
  ["stripe-key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["bearer", /\bBearer\s+[\w.~+/=-]{16,}/g],
  ["url-password", /(?<=:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/g],
];
/** Long random tokens (claim links, session keys): mixed case and digits, 32+ characters. UUIDs and git SHAs are not. */
const RANDOM_TOKEN = /(?<![\w-])[A-Za-z0-9_-]{32,}(?![\w-])/g;
const ASSIGNED_SECRET = /\b([\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[\w-]*)(\s*[:=]\s*)(["']?)([^\s"'`,;]{6,})\3/gi;

/** Replace credentials with `[redacted:<kind>]`; the text around them stays searchable. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [kind, pattern] of SECRET_PATTERNS) result = result.replace(pattern, `[redacted:${kind}]`);
  result = result.replace(RANDOM_TOKEN, (token) =>
    /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && !/^[A-Za-z]+(?:[-_][A-Za-z]+)*$/.test(token) ? "[redacted:token]" : token,
  );
  return result.replace(ASSIGNED_SECRET, (match, name: string, separator: string, quote: string, value: string) =>
    value.startsWith("[redacted:") ? match : `${name}${separator}${quote}[redacted:secret]${quote}`,
  );
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

export function projectRoot(cwd: string | null): string | null {
  return cwd ? withoutWorktree(cwd).replace(/\/+$/, "") || null : null;
}

export function projectName(cwd: string | null): string | null {
  const root = projectRoot(cwd);
  return root ? path.posix.basename(root) || null : null;
}

/** The store's own project name, else the working directory's. */
export function sessionProject(session: Pick<ParsedSession, "cwd" | "project">): string | null {
  return session.project ?? projectName(session.cwd);
}

function relativeTo(file: string, root: string | null): string {
  if (root && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return file;
}

/** One memory per session. Always fits in a single memory, so re-import updates it in place. */
export function sessionDigest(session: ParsedSession, agentLabel: string = session.agent): string {
  const firstPrompt = session.prompts[0] ? oneLine(session.prompts[0], 80) : "Untitled session";
  const title = oneLine(session.title ?? firstPrompt, 100);
  const date = (session.endedAt ?? session.startedAt ?? "").slice(0, 10);
  const meta = [agentLabel, sessionProject(session), date, `session ${session.id.slice(0, 8)}`].filter(Boolean).join(" · ");

  const sections: string[] = [`# Session: ${title}`, meta];
  const asked = session.prompts.slice(0, MAX_PROMPTS).map((prompt) => `- ${oneLine(prompt, PROMPT_MAX_CHARS)}`);
  if (session.prompts.length > MAX_PROMPTS) asked.push(`- …and ${session.prompts.length - MAX_PROMPTS} more`);
  sections.push(`## Asked\n${asked.join("\n")}`);

  const corrections = session.prompts.slice(1).filter((prompt) => CORRECTION_PATTERN.test(prompt.trim()));
  if (corrections.length) {
    sections.push(`## Corrections\n${corrections.slice(0, 6).map((prompt) => `- ${oneLine(prompt, 240)}`).join("\n")}`);
  }

  if (session.filesChanged.length) {
    const files = session.filesChanged.slice(0, MAX_FILES).map((file) => `- \`${relativeTo(file, projectRoot(session.cwd))}\``);
    if (session.filesChanged.length > MAX_FILES) files.push(`- …and ${session.filesChanged.length - MAX_FILES} more`);
    sections.push(`## Files changed\n${files.join("\n")}`);
  }

  const failed = session.commands.filter((command) => command.failed);
  if (failed.length) {
    const lines = failed.slice(0, MAX_FAILED_COMMANDS).map((command) => {
      const error = command.error ? ` → ${oneLine(command.error, 160)}` : "";
      return `- \`${oneLine(command.command, 160)}\`${error}`;
    });
    sections.push(`## Commands that failed\n${lines.join("\n")}`);
  }

  if (session.outcome) sections.push(`## Outcome\n${clip(session.outcome, OUTCOME_MAX_CHARS)}`);

  return clip(redactSecrets(sections.join("\n\n")), DIGEST_MAX_CHARS);
}

/** `30d`, `12h`, `2w`, or a bare number of days. */
export function parseSince(value: string, now = new Date()): Date | null {
  const match = value.trim().match(/^(\d+)\s*([hdw]?)$/i);
  if (!match) return null;
  const hours = { h: 1, d: 24, w: 24 * 7, "": 24 }[match[2].toLowerCase() as "h" | "d" | "w" | ""];
  return new Date(now.getTime() - Number(match[1]) * hours * 3_600_000);
}
