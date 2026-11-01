import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runImport } from "../src/import/run";
import {
  collectSessionFiles,
  parseClaudeCodeSession,
  parseCodexSession,
  parseSince,
  projectName,
  redactSecrets,
  sessionDigest,
} from "../src/import/sessions";
import { createTestBrain } from "./helpers";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "make0-sessions-"));
}

function writeJsonl(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const CWD = "/work/acme-api";

function claudeRecords(): unknown[] {
  const base = { cwd: CWD, sessionId: "c1a2b3c4-0000", isSidechain: false };
  return [
    { type: "ai-title", aiTitle: "Fix flaky checkout tests", sessionId: "c1a2b3c4-0000" },
    { ...base, type: "user", timestamp: "2026-10-30T10:00:00Z", message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { ...base, type: "user", isMeta: true, timestamp: "2026-10-30T10:00:01Z", message: { role: "user", content: "meta note" } },
    { ...base, type: "user", timestamp: "2026-10-30T10:00:02Z", message: { role: "user", content: "The checkout tests are flaky, fix them" } },
    {
      ...base,
      type: "assistant",
      timestamp: "2026-10-30T10:01:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
          { type: "tool_use", id: "t2", name: "Edit", input: { file_path: `${CWD}/src/checkout.ts` } },
          { type: "tool_use", id: "t3", name: "Write", input: { file_path: "/private/tmp/scratch.ts" } },
        ],
      },
    },
    {
      ...base,
      type: "user",
      timestamp: "2026-10-30T10:02:00Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "npm ERR! missing script: test\nmore" },
          { type: "tool_result", tool_use_id: "t2", content: "ok" },
        ],
      },
    },
    {
      ...base,
      type: "user",
      timestamp: "2026-10-30T10:03:00Z",
      message: { role: "user", content: [{ type: "text", text: "no, use pnpm vitest, OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123" }] },
    },
    { ...base, type: "user", isSidechain: true, timestamp: "2026-10-30T10:03:30Z", message: { role: "user", content: "subagent prompt" } },
    {
      ...base,
      type: "assistant",
      timestamp: "2026-10-30T10:04:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "Switched to pnpm vitest; the race in checkout.ts is fixed." }] },
    },
  ];
}

function codexRecords(): unknown[] {
  return [
    { type: "session_meta", timestamp: "2026-10-31T09:00:00Z", payload: { id: "019a-codex", cwd: "/work/web" } },
    { type: "response_item", timestamp: "2026-10-31T09:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { type: "response_item", timestamp: "2026-10-31T09:00:02Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a dark mode toggle" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["bash", "-lc", "pnpm build"] }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "error TS2304: Cannot find name 'theme'", metadata: { exit_code: 2 } }) } },
    { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "*** Begin Patch\n*** Update File: src/theme.ts\n*** Add File: src/toggle.tsx\n*** End Patch" } },
    { type: "event_msg", timestamp: "2026-10-31T09:05:00Z", payload: { type: "task_complete", last_agent_message: "Dark mode toggle added in src/toggle.tsx." } },
  ];
}

test("redactSecrets replaces credentials and keeps the surrounding text", () => {
  const text = [
    "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123",
    "postgres://admin:hunter2secret@db.local/app",
    'password: "correct-horse-battery"',
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123",
  ].join("\n");
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!redacted.includes("hunter2secret"));
  assert.ok(!redacted.includes("correct-horse-battery"));
  assert.match(redacted, /\[redacted:anthropic-key\]/);
  assert.match(redacted, /\[redacted:github-token\]/);
  assert.match(redacted, /postgres:\/\/admin:\[redacted:url-password\]@db\.local/);
  assert.match(redacted, /password: "\[redacted:secret\]"/);
  assert.equal(redactSecrets("plain text about tokens"), "plain text about tokens");
});

test("Claude Code transcript: prompts, files, failed commands, outcome", () => {
  const home = tempHome();
  const file = path.join(home, ".claude", "projects", "-work-acme-api", "c1a2b3c4-0000.jsonl");
  writeJsonl(file, claudeRecords());
  const session = parseClaudeCodeSession(file);
  assert.equal(session.title, "Fix flaky checkout tests");
  assert.equal(session.cwd, CWD);
  assert.equal(session.prompts.length, 2);
  assert.deepEqual(session.filesChanged, [`${CWD}/src/checkout.ts`]);
  assert.deepEqual(session.commands, [{ command: "npm test", failed: true, error: "npm ERR! missing script: test" }]);
  assert.equal(session.startedAt, "2026-10-30T10:00:00.000Z");

  const digest = sessionDigest(session);
  assert.match(digest, /^# Session: Fix flaky checkout tests\n\nClaude Code · acme-api · 2026-10-30/);
  assert.match(digest, /## Corrections\n- no, use pnpm vitest/);
  assert.match(digest, /- `src\/checkout\.ts`/);
  assert.match(digest, /`npm test` → npm ERR! missing script: test/);
  assert.match(digest, /## Outcome\nSwitched to pnpm vitest/);
  assert.ok(!digest.includes("sk-abcdefghijklmnopqrstuvwxyz123"));
  assert.ok(!digest.includes("subagent prompt"));
});

test("Codex transcript: shell exit codes and apply_patch files", () => {
  const home = tempHome();
  const file = path.join(home, ".codex", "sessions", "2026", "10", "31", "rollout-2026-10-31T09-00-00-019a.jsonl");
  writeJsonl(file, codexRecords());
  const session = parseCodexSession(file);
  assert.equal(session.id, "019a-codex");
  assert.deepEqual(session.prompts, ["Add a dark mode toggle"]);
  assert.deepEqual(session.commands, [{ command: "pnpm build", failed: true, error: "error TS2304: Cannot find name 'theme'" }]);
  assert.deepEqual(session.filesChanged, ["/work/web/src/theme.ts", "/work/web/src/toggle.tsx"]);
  assert.equal(session.outcome, "Dark mode toggle added in src/toggle.tsx.");
});

test("digest always fits in one memory", () => {
  const digest = sessionDigest({
    agent: "codex",
    id: "long",
    title: null,
    cwd: "/work/web",
    startedAt: null,
    endedAt: null,
    prompts: Array.from({ length: 40 }, (_, index) => `prompt ${index} ${"word ".repeat(200)}`),
    filesChanged: Array.from({ length: 80 }, (_, index) => `/work/web/src/file-${index}.ts`),
    commands: Array.from({ length: 30 }, (_, index) => ({ command: `cmd ${index}`, failed: true, error: "boom ".repeat(100) })),
    outcome: "done ".repeat(2000),
  });
  assert.ok(digest.length <= 4000);
  assert.match(digest, /…and 32 more/);
});

test("project name folds Claude Code worktrees into their repository", () => {
  assert.equal(projectName("/work/acme-api/.claude/worktrees/happy-otter-1a2b"), "acme-api");
  assert.equal(projectName("/work/acme-api/"), "acme-api");
  assert.equal(projectName(null), null);
});

test("parseSince accepts hours, days, and weeks", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  assert.equal(parseSince("12h", now)?.toISOString(), "2026-10-31T12:00:00.000Z");
  assert.equal(parseSince("2", now)?.toISOString(), "2026-10-30T00:00:00.000Z");
  assert.equal(parseSince("1w", now)?.toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(parseSince("soon", now), null);
});

test("import --sessions: one memory per session, idempotent, updated as a session grows", async () => {
  const home = tempHome();
  const claudeFile = path.join(home, ".claude", "projects", "-work-acme-api", "c1a2b3c4-0000.jsonl");
  writeJsonl(claudeFile, claudeRecords());
  writeJsonl(path.join(home, ".claude", "projects", "-work-acme-api", "empty.jsonl"), [
    { type: "user", cwd: CWD, message: { role: "user", content: "<local-command-stdout></local-command-stdout>" } },
  ]);
  writeJsonl(path.join(home, ".codex", "sessions", "2026", "10", "31", "rollout-x.jsonl"), codexRecords());

  const files = collectSessionFiles({ home });
  assert.equal(files.length, 2, "a session with no real prompt is skipped");
  assert.deepEqual(files.map((file) => file.source).sort(), ["claude-code-session", "codex-session"]);
  assert.deepEqual(collectSessionFiles({ home, agents: ["codex"] }).map((file) => file.source), ["codex-session"]);

  const brain = createTestBrain();
  const first = await runImport(brain, files);
  assert.equal(first.added, 2);
  const memories = brain.store.listImportedMemories(claudeFile);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].category, "Sessions · acme-api");
  assert.equal(memories[0].kind, "work");
  assert.equal(memories[0].entityType, "source");

  const again = await runImport(brain, collectSessionFiles({ home }));
  assert.equal(again.added, 0);
  assert.equal(again.unchanged, 2);

  const grown = [
    ...claudeRecords(),
    { type: "user", cwd: CWD, sessionId: "c1a2b3c4-0000", timestamp: "2026-10-30T11:00:00Z", message: { role: "user", content: "also add a regression test" } },
  ];
  writeJsonl(claudeFile, grown);
  const updated = await runImport(brain, collectSessionFiles({ home }));
  assert.equal(updated.updated, 1);
  assert.match(brain.store.listImportedMemories(claudeFile)[0].content, /also add a regression test/);
});

test("import --sessions --extract uses the session prompt", async () => {
  const home = tempHome();
  writeJsonl(path.join(home, ".codex", "sessions", "rollout-x.jsonl"), codexRecords());
  const brain = createTestBrain();
  const sources: Array<string | undefined> = [];
  brain.llm.extract = async (_name, _text, source) => {
    sources.push(source);
    return [{ content: "In the web project, the user builds with pnpm build.", category: "Web", kind: "work", entityType: "workflow", confidence: 90 }];
  };
  const summary = await runImport(brain, collectSessionFiles({ home }), { extract: true });
  assert.deepEqual(sources, ["session"]);
  assert.equal(summary.added, 1);
});
