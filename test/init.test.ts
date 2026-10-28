import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  detectClients,
  type InitEnv,
  MCP_CLIENTS,
  planConfigChange,
  planRulesChange,
  stripRulesBlock,
} from "../src/init/clients";
import { runInit } from "../src/init/run";
import { parseClientSelection, promptForClients } from "../src/init/select";

function tempHome(): InitEnv {
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), "make0-init-")), platform: "darwin" };
}

const client = (id: string) => MCP_CLIENTS.find((item) => item.id === id)!;

test("detects clients by their config folders", () => {
  const env = tempHome();
  fs.mkdirSync(path.join(env.home, ".cursor"));
  fs.mkdirSync(path.join(env.home, ".codex"));
  assert.deepEqual(detectClients(env).map((item) => item.id), ["cursor", "codex"]);
});

test("adds to mcpServers and keeps other servers and keys", () => {
  const env = tempHome();
  const file = client("cursor").configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
  const change = planConfigChange(client("cursor"), env);
  assert.equal(change.status, "added");
  const next = JSON.parse(change.contents!);
  assert.deepEqual(next.mcpServers.other, { command: "x" });
  assert.deepEqual(next.mcpServers["make0-brain"], { command: "npx", args: ["-y", "@make0-ai/brain"] });
  assert.equal(next.theme, "dark");
});

test("VS Code uses servers with type stdio; Windows wraps npx", () => {
  const env = { ...tempHome(), platform: "win32" as const, appData: "" };
  env.appData = path.join(env.home, "AppData");
  const change = planConfigChange(client("vscode"), env);
  assert.ok(change.file.endsWith(path.join("Code", "User", "mcp.json")));
  assert.deepEqual(JSON.parse(change.contents!).servers["make0-brain"], {
    type: "stdio",
    command: "cmd",
    args: ["/c", "npx", "-y", "@make0-ai/brain"],
  });
});

test("Codex TOML: append once, then unchanged", () => {
  const env = tempHome();
  const file = client("codex").configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const first = planConfigChange(client("codex"), env);
  assert.match(first.contents!, /\[mcp_servers\.make0-brain\]\ncommand = "npx"\nargs = \["-y", "@make0-ai\/brain"\]/);
  assert.match(first.contents!, /\[mcp_servers\.other\]/);
  fs.writeFileSync(file, first.contents!);
  assert.equal(planConfigChange(client("codex"), env).status, "unchanged");
});

test("rules block is added once and stripped for import", () => {
  const env = tempHome();
  const file = path.join(env.home, ".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "# My rules\n\nUse pnpm.\n");
  const change = planRulesChange(file);
  assert.equal(change.status, "added");
  fs.writeFileSync(file, change.contents!);
  assert.equal(planRulesChange(file).status, "unchanged");
  assert.equal(stripRulesBlock(change.contents!).trim(), "# My rules\n\nUse pnpm.");
});

test("runInit writes configs and rules, backs up, and is idempotent", async () => {
  const env = tempHome();
  fs.mkdirSync(path.join(env.home, ".claude"));
  fs.mkdirSync(path.join(env.home, ".cursor"));
  fs.writeFileSync(path.join(env.home, ".cursor", "mcp.json"), "{}");
  const log: string[] = [];
  const result = await runInit({ env, confirm: async () => true, log: (line) => log.push(line), claudeCli: null });
  assert.deepEqual(result.configured, ["claude-code", "cursor"]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(env.home, ".claude.json"), "utf8")).mcpServers["make0-brain"]);
  assert.ok(fs.existsSync(path.join(env.home, ".cursor", "mcp.json.make0-backup")));
  assert.match(fs.readFileSync(path.join(env.home, ".claude", "CLAUDE.md"), "utf8"), /make0-brain:begin/);
  assert.ok(log.join("\n").includes("Cursor → Settings → Rules"));

  const again: string[] = [];
  await runInit({ env, confirm: async () => true, log: (line) => again.push(line), claudeCli: null });
  assert.ok(again[0].includes("unchanged"));
});

test("runInit prefers the claude CLI for Claude Code", async () => {
  const env = tempHome();
  fs.mkdirSync(path.join(env.home, ".claude"));
  const calls: string[][] = [];
  await runInit({
    env,
    rules: false,
    confirm: async () => true,
    log: () => {},
    claudeCli: (args) => {
      calls.push(args);
      return { status: 0 };
    },
  });
  assert.deepEqual(calls[1], ["mcp", "add", "--scope", "user", "make0-brain", "--", "npx", "-y", "@make0-ai/brain"]);
  assert.equal(fs.existsSync(path.join(env.home, ".claude.json")), false);
});

test("dry run and declined confirm change nothing", async () => {
  const env = tempHome();
  fs.mkdirSync(path.join(env.home, ".cursor"));
  await runInit({ env, dryRun: true, confirm: async () => true, log: () => {}, claudeCli: null });
  await runInit({ env, confirm: async () => false, log: () => {}, claudeCli: null });
  assert.equal(fs.existsSync(path.join(env.home, ".cursor", "mcp.json")), false);
});

test("models download after configuring, and not on dry run or decline", async () => {
  const env = tempHome();
  fs.mkdirSync(path.join(env.home, ".cursor"));
  const order: string[] = [];
  const prefetchModels = async () => {
    order.push(fs.existsSync(path.join(env.home, ".cursor", "mcp.json")) ? "models-after-config" : "models-before-config");
  };
  await runInit({ env, dryRun: true, confirm: async () => true, log: () => {}, claudeCli: null, prefetchModels });
  await runInit({ env, confirm: async () => false, log: () => {}, claudeCli: null, prefetchModels });
  assert.deepEqual(order, []);
  const log: string[] = [];
  await runInit({ env, confirm: async () => true, log: (line) => log.push(line), claudeCli: null, prefetchModels });
  assert.deepEqual(order, ["models-after-config"]);
  assert.ok(log.some((line) => /Restart the app/.test(line)));
});

test("models still download when no client is found", async () => {
  let calls = 0;
  await runInit({
    env: tempHome(),
    confirm: async () => true,
    log: () => {},
    claudeCli: null,
    prefetchModels: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 1);
});

test("parseClientSelection accepts numbers, ranges, ids, all, and none", () => {
  const clients = [client("cursor"), client("codex"), client("gemini")];
  const ids = (answer: string) => {
    const picked = parseClientSelection(answer, clients);
    assert.ok(picked);
    return picked.map((item) => item.id);
  };
  assert.deepEqual(ids(""), ["cursor", "codex", "gemini"]);
  assert.deepEqual(ids("ALL"), ["cursor", "codex", "gemini"]);
  assert.deepEqual(ids("1,3"), ["cursor", "gemini"]);
  assert.deepEqual(ids("1-2"), ["cursor", "codex"]);
  assert.deepEqual(ids("codex, cursor"), ["codex", "cursor"]);
  assert.deepEqual(ids("1,1"), ["cursor"]);
  assert.deepEqual(parseClientSelection("none", clients), []);
  assert.equal(parseClientSelection("9", clients), null);
  assert.equal(parseClientSelection("cursor,notepad", clients), null);
  assert.equal(parseClientSelection("3-1", clients), null);
});

test("promptForClients repeats until the answer parses", async () => {
  const clients = [client("cursor"), client("codex"), client("gemini")];
  const answers = ["nope", "1,gemini"];
  const log: string[] = [];
  const picked = await promptForClients(
    clients,
    async () => answers.shift() ?? "",
    (line) => log.push(line),
  );
  assert.deepEqual(picked.map((item) => item.id), ["cursor", "gemini"]);
  assert.ok(log.some((line) => line.includes("1. Cursor")));
  assert.ok(log.some((line) => line.includes("Use 1-3")));
});

test("unknown client ids are rejected", async () => {
  await assert.rejects(
    runInit({ env: tempHome(), clientIds: ["notepad"], confirm: async () => true, log: () => {}, claudeCli: null }),
    /Unknown client: notepad/,
  );
});
