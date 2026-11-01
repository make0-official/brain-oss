import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "vitest";
import { collectSessionFiles, collectSessionFilesAsync, redactSecrets, SESSION_AGENTS, type ScanProgress } from "../src/import/sessions";
import { cleanUserText, exitCodeFrom, SessionBuilder, toIso } from "../src/import/sessions/session";
import { decodeProjectDir } from "../src/import/sessions/store";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "make0-readers-"));
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeJsonl(file: string, records: unknown[]): void {
  write(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function sqlite(file: string, sql: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(sql);
  db.close();
}

function collect(home: string, agents?: string[]) {
  const warnings: string[] = [];
  const files = collectSessionFiles({ home, env: {}, platform: "darwin", agents, warn: (line) => warnings.push(line) });
  assert.deepEqual(warnings, []);
  return files;
}

function only(home: string, agent: string) {
  const files = collect(home, [agent]);
  assert.equal(files.length, 1, `${agent}: expected one session, got ${files.length}`);
  return files[0];
}

test("the registry lists every agent once", () => {
  const ids = SESSION_AGENTS.map((agent) => agent.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 40);
  for (const id of ["claude-code", "codex", "cursor", "copilot-chat", "gemini", "opencode", "cline", "aider", "zed"]) assert.ok(ids.includes(id), id);
});

test("SessionBuilder: shell tools become commands, editors name files, exit codes fail them", () => {
  const builder = new SessionBuilder("test", "s1").setCwd("/work/api");
  builder.message("user", "<system-reminder>rules</system-reminder>fix the build");
  builder.message("assistant", [
    { type: "text", text: "running it" },
    { type: "tool_use", id: "a", name: "developer__shell", input: { command: "npm test" } },
    { type: "toolCall", id: "b", name: "edit", arguments: { path: "src/a.ts" } },
    { type: "tool_use", id: "c", name: "text_editor", input: { command: "view", path: "src/skip.ts" } },
    { type: "tool_use", id: "d", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/b.ts\n*** End Patch" },
  ]);
  builder.message("tool", "FAIL src/a.test.ts\nExit code: 1", { toolCallId: "a" });
  builder.message("assistant", null, { toolCalls: [{ id: "e", function: { name: "run_terminal_cmd", arguments: '{"command":"git push"}' } }] });
  builder.result("e", { text: "denied", exitCode: -1 });
  const session = builder.build();
  assert.deepEqual(session.prompts, ["fix the build"]);
  assert.deepEqual(session.filesChanged, ["/work/api/src/a.ts", "/work/api/src/b.ts"]);
  assert.deepEqual(session.commands, [
    { command: "npm test", failed: true, error: "FAIL src/a.test.ts" },
    { command: "git push", failed: false },
  ]);
  assert.equal(session.outcome, "running it");
});

test("helpers: user text cleanup, exit codes, times, and random-token redaction", () => {
  assert.equal(cleanUserText("<task>\nFix it\n</task>\n<environment_details>cwd</environment_details>"), "Fix it");
  assert.equal(cleanUserText("<command-name>/clear</command-name>"), null);
  assert.equal(exitCodeFrom('{"output":"x","metadata":{"exit_code":2}}'), 2);
  assert.equal(exitCodeFrom("Command failed with exit code 127"), 127);
  assert.equal(exitCodeFrom("all good"), null);
  assert.equal(toIso(1784278801), "2026-07-17T09:00:01.000Z");
  assert.equal(toIso(1784278801000), "2026-07-17T09:00:01.000Z");
  assert.equal(toIso(1784278801000000), "2026-07-17T09:00:01.000Z");
  const text = "claim https://x.dev/claim/moltbook_claim__wcBqXKc_2Y0WtxsT2nzem4BrV1 id 6f7df64a-23b9-414e-974f-301b03b960f0 sha 4063b5a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6";
  const redacted = redactSecrets(text);
  assert.match(redacted, /claim\/\[redacted:token\]/);
  assert.match(redacted, /6f7df64a-23b9-414e-974f-301b03b960f0/);
  assert.match(redacted, /4063b5a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6/);
});

test("decodeProjectDir walks the disk to undo a lossy folder name", () => {
  const root = tempHome();
  fs.mkdirSync(path.join(root, "work", "ai_billion", "my-app"), { recursive: true });
  assert.equal(decodeProjectDir("work-ai-billion-my-app", root), path.join(root, "work", "ai_billion", "my-app"));
  assert.equal(decodeProjectDir("work-missing", root), null);
});

test("pi family and OpenClaw's SQLite store", () => {
  const home = tempHome();
  const piLines = [
    { type: "session", version: 3, id: "pi-1", timestamp: "2026-10-01T10:00:00Z", cwd: "/work/api" },
    { type: "message", timestamp: "2026-10-01T10:00:05Z", message: { role: "user", content: [{ type: "text", text: "why does the cron fire twice" }] } },
    { type: "message", timestamp: "2026-10-01T10:00:06Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "systemctl list-timers" } }] } },
    { type: "message", timestamp: "2026-10-01T10:00:07Z", message: { role: "toolResult", toolCallId: "t1", isError: true, content: [{ type: "text", text: "Unit not found" }] } },
    { type: "message", timestamp: "2026-10-01T10:00:08Z", message: { role: "assistant", content: [{ type: "text", text: "Two units were enabled." }] } },
  ];
  writeJsonl(path.join(home, ".pi", "agent", "sessions", "--work-api--", "2026-10-01T10-00-00_pi-1.jsonl"), piLines);
  const pi = only(home, "pi");
  assert.equal(pi.folder, "api");
  assert.match(pi.text, /`systemctl list-timers` → Unit not found/);
  assert.match(pi.text, /## Outcome\nTwo units were enabled\./);

  const db = path.join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
  sqlite(db, "create table transcript_events (session_id text, seq integer, event_json text, created_at integer);");
  const conn = new Database(db);
  const insert = conn.prepare("insert into transcript_events values (?, ?, ?, ?)");
  piLines.forEach((line, seq) => insert.run("oc-1", seq, JSON.stringify(line), 1790000000000 + seq));
  conn.close();
  const openclaw = only(home, "openclaw");
  assert.equal(openclaw.path, `${db}#oc-1`);
  assert.match(openclaw.text, /^# Session: why does the cron fire twice/);
});

test("opencode, Hermes and Devin SQLite stores", () => {
  const home = tempHome();
  sqlite(
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    `create table session (id text primary key, directory text, title text, parent_id text, time_created any, time_updated any);
     create table message (id text primary key, session_id text, time_created any, data text);
     create table part (id text primary key, message_id text, data text);
     insert into session values ('oc', '/work/web', 'fix vet', null, 1790000000000, 1790000060000);
     insert into session values ('child', '/work/web', 'subagent', 'oc', 1790000000000, 1790000060000);
     insert into message values ('m1', 'oc', 1790000001000, '{"role":"user"}');
     insert into message values ('m2', 'oc', 1790000002000, '{"role":"assistant"}');
     insert into part values ('p1', 'm1', '{"type":"text","text":"go vet fails"}');
     insert into part values ('p2', 'm2', '{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"go vet ./..."},"output":"pattern ./...: no module","metadata":{"exit":1}}}');
     insert into part values ('p3', 'm2', '{"type":"text","text":"Run it from the module root."}');`,
  );
  const opencode = only(home, "opencode");
  assert.equal(opencode.name, "fix vet");
  assert.match(opencode.text, /`go vet \.\/\.\.\.` → pattern \.\/\.\.\.: no module/);

  sqlite(
    path.join(home, ".hermes", "state.db"),
    `create table messages (id integer primary key autoincrement, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real);
     create table sessions (id text, cwd text, title text);
     insert into sessions values ('h1', '/work/fetcher', 'backoff');
     insert into messages (session_id, role, content, timestamp) values ('h1', 'user', 'the retry loop never backs off', 1790000000);
     insert into messages (session_id, role, content, tool_calls, timestamp) values ('h1', 'assistant', null, '[{"id":"t1","function":{"name":"terminal","arguments":"{\\"command\\":\\"pytest\\"}"}}]', 1790000001);
     insert into messages (session_id, role, content, tool_call_id, timestamp) values ('h1', 'tool', '{"output":"1 failed","exit_code":1}', 't1', 1790000002);`,
  );
  const hermes = only(home, "hermes");
  assert.equal(hermes.folder, "fetcher");
  assert.match(hermes.text, /`pytest` → 1 failed/);

  sqlite(
    path.join(home, ".local", "share", "devin", "cli", "sessions.db"),
    `create table sessions (id text, working_directory text, created_at integer, last_activity_at integer, title text, main_chain_id integer, hidden integer default 0);
     create table message_nodes (row_id integer primary key, session_id text, node_id integer, parent_node_id integer, chat_message text, created_at integer, metadata text);
     insert into sessions values ('d1', '/work/api', 1790000000, 1790000090, 'loop', 3, 0);
     insert into sessions values ('hidden', '/work/api', 1790000000, 1790000090, 'x', 1, 1);
     insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) values
       ('d1', 1, null, '{"message_id":"s","role":"system","content":"rules"}', 1790000001, '{"is_system_prefix":true}'),
       ('d1', 2, 1, '{"message_id":"u","role":"user","content":"the loop drops the last attempt"}', 1790000002, null),
       ('d1', 3, 2, '{"message_id":"a","role":"assistant","content":"Fixed the bound."}', 1790000003, null),
       ('d1', 9, 2, '{"message_id":"orphan","role":"assistant","content":"rewound away"}', 1790000004, null);`,
  );
  const devin = only(home, "devin");
  assert.match(devin.text, /## Outcome\nFixed the bound\./);
  assert.doesNotMatch(devin.text, /rewound away/);
});

test("VS Code Copilot Chat mutation log and Cline extension task", () => {
  const home = tempHome();
  const user = path.join(home, "Library", "Application Support", "Code", "User");
  write(path.join(user, "workspaceStorage", "w1", "workspace.json"), JSON.stringify({ folder: "file:///work/my%20app" }));
  writeJsonl(path.join(user, "workspaceStorage", "w1", "chatSessions", "c1.jsonl"), [
    { kind: 0, v: { sessionId: "c1", creationDate: 1790000000000, customTitle: "retry loop", requests: [] } },
    { kind: 2, k: ["requests"], v: [{ timestamp: 1790000001000, message: { text: "the retry loop drops the last attempt" }, response: [{ value: "Use <=." }] }] },
    { kind: 2, k: ["requests"], v: [{ timestamp: 1790000002000, message: { text: "add a test" }, response: [{ kind: "toolInvocationSerialized", toolSpecificData: { commandLine: { original: "npm test" } } }, { value: "Added it." }] }] },
  ]);
  const chat = only(home, "copilot-chat");
  assert.equal(chat.folder, "my app");
  assert.equal(chat.name, "retry loop");
  assert.match(chat.text, /- add a test/);
  assert.match(chat.text, /## Outcome\nAdded it\./);

  const cline = path.join(user, "globalStorage", "saoudrizwan.claude-dev");
  write(path.join(cline, "state", "taskHistory.json"), JSON.stringify([{ id: "t1", ts: 1790000000000, task: "Fix it", cwdOnTaskInitialization: "/work/demo" }]));
  write(
    path.join(cline, "tasks", "t1", "api_conversation_history.json"),
    JSON.stringify([
      { role: "user", content: [{ type: "text", text: "<task>\nFix the flaky test\n</task>" }, { type: "text", text: "<environment_details>x</environment_details>" }] },
      { role: "assistant", content: [{ type: "text", text: "Running tests.\n<execute_command>\n<command>npm test</command>\n</execute_command>" }] },
      { role: "user", content: [{ type: "text", text: "[execute_command for 'npm test'] Result:\nok\n<feedback>\nuse pnpm instead\n</feedback>" }] },
      { role: "assistant", content: [{ type: "text", text: "Switched to pnpm.\n<write_to_file>\n<path>package.json</path>\n</write_to_file>" }] },
    ]),
  );
  const task = only(home, "cline");
  assert.equal(task.folder, "demo");
  assert.match(task.text, /- Fix the flaky test\n- use pnpm instead/);
  assert.match(task.text, /- `package\.json`/);
  assert.match(task.text, /## Outcome\nSwitched to pnpm\.$/);
});

test("Gemini CLI, Cursor transcripts, Copilot CLI and aider", () => {
  const home = tempHome();
  writeJsonl(path.join(home, ".gemini", "tmp", "p1", "chats", "session-1.jsonl"), [
    { sessionId: "g1", startTime: "2026-10-01T09:00:00Z" },
    { id: "m1", timestamp: "2026-10-01T09:00:01Z", type: "user", content: "why is the build slow" },
    { id: "m2", timestamp: "2026-10-01T09:00:02Z", type: "gemini", content: [{ text: "first answer" }] },
    { $rewindTo: "m2" },
    { id: "m3", timestamp: "2026-10-01T09:00:03Z", type: "gemini", content: [{ text: "Caching is off." }] },
  ]);
  write(path.join(home, ".gemini", "tmp", "p1", ".project_root"), "/work/builds\n");
  const gemini = only(home, "gemini");
  assert.equal(gemini.folder, "builds");
  assert.match(gemini.text, /## Outcome\nCaching is off\./);

  writeJsonl(path.join(home, ".cursor", "projects", "work-api", "agent-transcripts", "c1", "c1.jsonl"), [
    { role: "user", message: { content: [{ type: "text", text: "<timestamp>Sunday, Oct 4, 2026, 1:06 PM (UTC+3)</timestamp>\n<user_query>\nwhy is the cache stale\n</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: { command: "npm run build" } }, { type: "text", text: "The key omitted the locale." }] } },
  ]);
  const cursor = only(home, "cursor");
  assert.match(cursor.text, /- why is the cache stale/);
  assert.match(cursor.text, /Cursor · api · 2026-10-04/);

  writeJsonl(path.join(home, ".copilot", "session-state", "s1", "events.jsonl"), [
    { type: "session.start", data: { sessionId: "s1", context: { cwd: "/work/gateway" } }, timestamp: "2026-10-02T05:00:00Z" },
    { type: "user.message", data: { content: "why is the pool exhausted" }, timestamp: "2026-10-02T05:00:01Z" },
    { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash", arguments: { command: "go test ./..." } } },
    { type: "tool.execution_complete", data: { toolCallId: "t1", success: true, result: { content: "FAIL pool_test.go\n<exited with exit code 1>" } } },
    { type: "assistant.message", data: { content: "Close rows in the scan loop." }, timestamp: "2026-10-02T05:00:09Z" },
  ]);
  const copilot = only(home, "copilot");
  assert.equal(copilot.folder, "gateway");
  assert.match(copilot.text, /`go test \.\/\.\.\.` → FAIL pool_test\.go/);

  write(
    path.join(home, ".aider.chat.history.md"),
    "# aider chat started at 2026-10-01 09:00:00\n\n#### fix the query\n\nAdded the tenant predicate.\n\n> Applied edit to query.go\n\n# aider chat started at 2026-10-02 09:00:00\n\n#### /add x.go\n\n#### now the index\n\nAdded an index.\n",
  );
  const aider = collect(home, ["aider"]);
  assert.equal(aider.length, 2);
  assert.ok(aider.every((file) => file.path.includes(".aider.chat.history.md#")));
  assert.match(aider[0].text, /- `query\.go`/);
});

test("one session in two of an agent's stores is imported once, from the copy that knows its project", () => {
  const home = tempHome();
  writeJsonl(path.join(home, ".cursor", "projects", "work-api", "agent-transcripts", "same", "same.jsonl"), [
    { role: "user", message: { content: [{ type: "text", text: "<user_query>one question</user_query>" }] } },
  ]);
  sqlite(
    path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    `create table cursorDiskKV (key text primary key, value blob);
     insert into cursorDiskKV values ('composerData:same', '{"composerId":"same","name":"IDE copy","lastUpdatedAt":1790000000000,"fullConversationHeadersOnly":[{"bubbleId":"b1","type":1}]}');
     insert into cursorDiskKV values ('bubbleId:same:b1', '{"type":1,"text":"one question"}');
     insert into cursorDiskKV values ('composerData:other', '{"composerId":"other","name":"IDE only","lastUpdatedAt":1790000000000,"workspaceIdentifier":{"uri":{"fsPath":"/work/web"}},"fullConversationHeadersOnly":[{"bubbleId":"b2","type":1}]}');
     insert into cursorDiskKV values ('bubbleId:other:b2', '{"type":1,"text":"another question"}');`,
  );
  fs.mkdirSync(path.join(home, "work", "api"), { recursive: true });
  const files = collect(home, ["cursor"]);
  assert.equal(files.length, 2);
  const same = files.find((file) => file.text.includes("one question"))!;
  assert.ok(same.path.endsWith("same.jsonl"));
  assert.equal(files.find((file) => file.name === "IDE only")!.folder, "web");
});

test("Zed threads (current and legacy documents) and Grok Build updates", () => {
  const home = tempHome();
  const current = JSON.stringify({
    version: "0.3.0",
    title: "where are threads kept",
    updated_at: "2026-10-03T09:00:02Z",
    messages: [
      { User: { id: "u1", content: [{ Text: "where does zed keep its agent threads?" }] } },
      {
        Agent: {
          content: [{ Text: "In threads.db." }, { ToolUse: { id: "t1", name: "terminal", input: { command: "ls ~/.zed" } } }],
          tool_results: { t1: { is_error: true, content: { Text: "No such file or directory" } } },
        },
      },
      "Resume",
    ],
  });
  const legacy = JSON.stringify({
    version: "0.2.0",
    summary: "legacy thread",
    updated_at: "2026-10-02T09:00:00Z",
    messages: [{ id: 1, role: "user", segments: [{ type: "text", text: "does the old shape load?" }] }],
  });
  const db = path.join(home, "Library", "Application Support", "Zed", "threads", "threads.db");
  sqlite(db, "create table threads (id text primary key, summary text, updated_at text, data_type text, data blob, folder_paths text);");
  const conn = new Database(db);
  conn.prepare("insert into threads values (?, ?, ?, 'json', ?, ?)").run("z1", "x", "2026-10-03T09:00:02Z", current, "/work/editor");
  conn.prepare("insert into threads values (?, ?, ?, 'json', ?, null)").run("z2", "y", "2026-10-02T09:00:00Z", legacy);
  conn.close();
  const zed = collect(home, ["zed"]);
  assert.equal(zed.length, 2);
  const thread = zed.find((file) => file.name === "where are threads kept")!;
  assert.equal(thread.folder, "editor");
  assert.match(thread.text, /`ls ~\/\.zed` → No such file or directory/);
  assert.ok(zed.some((file) => file.text.includes("does the old shape load?")));

  const session = path.join(home, ".grok", "sessions", "work%2Fdemo", "g1");
  write(path.join(session, "summary.json"), JSON.stringify({ info: { id: "g1", cwd: "/work/demo" }, title: "chunked answer" }));
  writeJsonl(path.join(session, "updates.jsonl"), [
    { timestamp: 1790000000, params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "why is it " } }, _meta: { promptIndex: 0 } } },
    { timestamp: 1790000000, params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "slow" } }, _meta: { promptIndex: 0 } } },
    { timestamp: 1790000002, params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The first chunk " } }, _meta: { promptId: "p1" } } },
    { timestamp: 1790000003, params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "and the second." } }, _meta: { promptId: "p1" } } },
  ]);
  const grok = only(home, "grok");
  assert.equal(grok.folder, "demo");
  assert.match(grok.text, /- why is it slow/);
  assert.match(grok.text, /## Outcome\nThe first chunk and the second\./);
});

test("since and limit: only the newest sessions inside the window are read", () => {
  const home = tempHome();
  const day = 86_400_000;
  for (let index = 0; index < 5; index += 1) {
    const file = path.join(home, ".pi", "agent", "sessions", "--w--", `s${index}.jsonl`);
    writeJsonl(file, [{ type: "message", message: { role: "user", content: `question ${index}` } }]);
    const when = new Date(Date.now() - (40 - index * 10) * day);
    fs.utimesSync(file, when, when);
  }
  const ask = (options: { since?: Date; limit?: number }) =>
    collectSessionFiles({ home, env: {}, platform: "darwin", agents: ["pi"], ...options }).map((file) => file.text.match(/question \d/)![0]);
  assert.deepEqual(ask({}), ["question 0", "question 1", "question 2", "question 3", "question 4"]);
  assert.deepEqual(ask({ since: new Date(Date.now() - 30 * day - 1000) }), ["question 1", "question 2", "question 3", "question 4"]);
  assert.deepEqual(ask({ limit: 2 }), ["question 3", "question 4"]);
});

test("Cursor IDE: composerHeaders filters by time before any chat is read", () => {
  const home = tempHome();
  const old = Date.now() - 90 * 86_400_000;
  sqlite(
    path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    `create table cursorDiskKV (key text primary key, value blob);
     create table composerHeaders (composerId text primary key, lastUpdatedAt integer, isSubagent integer);
     insert into composerHeaders values ('new', ${Date.now()}, 0), ('old', ${old}, 0), ('sub', ${Date.now()}, 1);
     insert into cursorDiskKV values ('composerData:new', '{"composerId":"new","lastUpdatedAt":${Date.now()},"fullConversationHeadersOnly":[{"bubbleId":"b","type":1}]}');
     insert into cursorDiskKV values ('composerData:old', '{"composerId":"old","lastUpdatedAt":${old},"fullConversationHeadersOnly":[{"bubbleId":"b","type":1}]}');
     insert into cursorDiskKV values ('composerData:sub', '{"composerId":"sub","lastUpdatedAt":${Date.now()},"fullConversationHeadersOnly":[{"bubbleId":"b","type":1}]}');
     insert into cursorDiskKV values ('bubbleId:new:b', '{"type":1,"text":"recent question"}');
     insert into cursorDiskKV values ('bubbleId:old:b', '{"type":1,"text":"old question"}');
     insert into cursorDiskKV values ('bubbleId:sub:b', '{"type":1,"text":"subagent task"}');`,
  );
  const files = collectSessionFiles({ home, env: {}, platform: "darwin", agents: ["cursor"], since: new Date(Date.now() - 30 * 86_400_000) });
  assert.deepEqual(files.map((file) => file.text.match(/## Asked\n- (.*)/)![1]), ["recent question"]);
});

test("the async scan finds the same sessions and reports where it is", async () => {
  const home = tempHome();
  for (let index = 0; index < 7; index += 1) {
    writeJsonl(path.join(home, ".pi", "agent", "sessions", "--w--", `s${index}.jsonl`), [{ type: "message", message: { role: "user", content: `question ${index}` } }]);
  }
  const events: ScanProgress[] = [];
  const options = { home, env: {}, platform: "darwin" as const, agents: ["pi", "codex"] };
  const files = await collectSessionFilesAsync({ ...options, onProgress: (event) => events.push(event) });
  assert.deepEqual(files.map((file) => file.path).sort(), collectSessionFiles(options).map((file) => file.path).sort());
  assert.deepEqual(events.filter((event) => event.phase === "finding").map((event) => event.agent), ["codex", "pi"]);
  const reading = events.filter((event) => event.phase === "reading");
  assert.equal(reading.length, 7);
  assert.deepEqual(reading.at(-1), { phase: "reading", agent: "pi", done: 6, total: 7 });
});
