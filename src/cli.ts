#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../package.json";
import { agentsCommand, brainsCommand, printStats, resolveBrainArg } from "./commands/brains";
import { brainHome, defaultDbPath, localModelsFor, openBrain } from "./config";
import { loadEnvFiles } from "./env";
import { writeBundle, writeMarkdownExport } from "./export/export";
import { runImport, stdinImportFile } from "./import/run";
import { collectImportFiles, detectAgentFiles, type ImportFile } from "./import/sources";
import { detectClients } from "./init/clients";
import { prefetchModels } from "./init/models";
import { runInit } from "./init/run";
import { promptForClients } from "./init/select";
import { resolveLlmConfig } from "./llm/client";
import { createBrainMcpServer } from "./mcp/server";
import { BrainStore } from "./store/store";
import { startViewer } from "./view/server";

loadEnvFiles();

const HELP = `Make0 Brain ${version} — one memory for Claude, ChatGPT, Cursor, and every AI you use.

Usage:
  make0-brain                      Run the MCP server over stdio
  make0-brain init                 Add Make0 Brain to the agents you choose
                                   (Claude Code, Claude Desktop, Cursor, Windsurf,
                                   VS Code, Codex, Gemini CLI)
      --clients <ids>              Skip the prompt; only these (comma-separated)
      --no-rules                   Skip the "search Brain first" rule
      --no-models                  Skip downloading the local models now
      --dry-run, --yes
  make0-brain import <path…>       Import Markdown files, folders, or an Obsidian vault
  make0-brain import --detect      Import CLAUDE.md, AGENTS.md, Cursor/Windsurf rules
  make0-brain import -             Import text from stdin
      --extract                    Extract atomic facts with your API key
      --brain <id>                 Import into this brain (default personal)
      --dry-run, --yes
  make0-brain export [dir]         Markdown files, one per memory (default ./make0-brain-export)
  make0-brain export --json [file] Port bundle (default ./make0-brain-bundle.json)
      --brain <id>                 Limit the export to one brain
  make0-brain brains               List brains
  make0-brain brains create <name> [--description <text>] [--emoji <emoji>] [--agents <ids>]
  make0-brain brains edit <id>     [--name <name>] [--description <text>] [--emoji <emoji>]
  make0-brain brains delete <id> --yes
  make0-brain agents               Show which brains each app can use
  make0-brain agents grant <client> <brain…>
  make0-brain agents revoke <client> <brain…>
  make0-brain view                 Open the memory list in a browser (--port, --no-open, --brain <id>)
  make0-brain stats                Show memory and link counts (--brain <id>)
  make0-brain history <id>         List saved versions of a memory
  make0-brain restore <id>         Restore an archived memory
  make0-brain restore <id> --version <n>
                                   Make version n current
  make0-brain purge <id> --yes     Permanently delete a memory and its versions

Environment (./.env, then $MAKE0_BRAIN_HOME/.env, default ~/.make0/.env;
variables already set in the environment win — see .env.example):
  MAKE0_BRAIN_HOME                 Data folder (default ~/.make0)
  MAKE0_BRAIN_DB                   Database file (default $MAKE0_BRAIN_HOME/brain.db)
  MAKE0_BRAIN_API_KEY              Optional key (or OPENROUTER_API_KEY / OPENAI_API_KEY):
                                   merges duplicates, classifies, filters search, --extract
  MAKE0_BRAIN_BASE_URL             OpenAI-compatible endpoint
  MAKE0_BRAIN_LLM_MODEL            Chat model (default gpt-6-luna)
  MAKE0_BRAIN_EMBEDDINGS           local (default) | api
  MAKE0_BRAIN_LLM_SEARCH=0         Keep search on the local reranker
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Positional args, skipping flags and the values of `valueFlags`. */
function positionals(args: string[], valueFlags: string[] = []): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (valueFlags.includes(args[index])) index += 1;
    else if (!args[index].startsWith("--")) result.push(args[index]);
  }
  return result;
}

/** y/N prompt; `--yes` skips it, and no TTY means no. */
async function confirm(question: string, args: string[], defaultYes = false): Promise<boolean> {
  if (args.includes("--yes") || args.includes("-y")) return true;
  if (!process.stdin.isTTY) {
    console.error(`${question} Re-run with --yes to confirm.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  rl.close();
  return answer === "" ? defaultYes : answer === "y" || answer === "yes";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** `--clients` and `--yes` skip the picker. Otherwise ask when more than one agent is installed. */
async function chooseInitClients(args: string[]): Promise<string[] | undefined> {
  const flagged = flagValue(args, "--clients")?.split(",").map((id) => id.trim()).filter(Boolean);
  if (flagged) return flagged;
  if (args.includes("--yes") || args.includes("-y") || !process.stdin.isTTY) return undefined;

  const detected = detectClients({ home: os.homedir(), platform: process.platform, appData: process.env.APPDATA });
  if (detected.length < 2) return undefined;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const picked = await promptForClients(detected, (question) => rl.question(question), (line) => console.log(line));
    return picked.map((client) => client.id);
  } finally {
    rl.close();
  }
}

async function init(args: string[]): Promise<void> {
  const clientIds = await chooseInitClients(args);
  if (clientIds?.length === 0) {
    console.log("Nothing changed.");
    return;
  }
  await runInit({
    env: { home: os.homedir(), platform: process.platform, appData: process.env.APPDATA },
    clientIds,
    rules: !args.includes("--no-rules"),
    dryRun: args.includes("--dry-run"),
    confirm: () => confirm("\nApply these changes?", args, true),
    log: (line) => console.log(line),
    prefetchModels: args.includes("--no-models")
      ? undefined
      : () =>
          prefetchModels(localModelsFor(), path.join(brainHome(), "models"), {
            log: (line) => console.log(line),
            write: process.stdout.isTTY ? (text) => process.stdout.write(text) : undefined,
          }),
  });
}

async function importCommand(args: string[]): Promise<void> {
  const targets = positionals(args, ["--brain"]);
  const files: ImportFile[] = [];
  if (args.includes("--detect")) {
    const found = detectAgentFiles(os.homedir(), process.cwd());
    if (found.length === 0) console.log("No agent rule files found (CLAUDE.md, AGENTS.md, .cursor/rules, …).");
    else console.log(`Found:\n${found.map((file) => `  • ${file}`).join("\n")}`);
    for (const file of found) files.push(...collectImportFiles(file));
  }
  for (const target of targets) {
    if (target === "-") files.push(stdinImportFile(await readStdin()));
    else if (!fs.existsSync(target)) fail(`Not found: ${target}`);
    else files.push(...collectImportFiles(target));
  }
  if (files.length === 0) {
    if (!args.includes("--detect")) fail("Usage: make0-brain import <path…> | --detect | -");
    return;
  }
  const extract = args.includes("--extract");
  if (extract && !resolveLlmConfig()) {
    fail("--extract needs an API key in .env or ~/.make0/.env (OPENAI_API_KEY, OPENROUTER_API_KEY, or MAKE0_BRAIN_API_KEY).");
  }

  const brain = openBrain();
  try {
    const brainId = resolveBrainArg(brain.store, flagValue(args, "--brain"));
    await runImport(brain, files, {
      brainId,
      extract,
      dryRun: args.includes("--dry-run"),
      confirm: (summary) => confirm(summary, args),
      log: (line) => console.log(line),
    });
  } finally {
    brain.store.close();
  }
}

async function serve(): Promise<void> {
  // stdout carries MCP frames; send every log line to stderr.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;

  const brain = openBrain();
  const server = createBrainMcpServer(brain, { version });
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await server.close();
    brain.store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

/** Local list view. The list reads SQLite. The first save or embedding view loads the embedder. */
async function viewCommand(args: string[]): Promise<void> {
  const portArg = flagValue(args, "--port");
  const port = portArg == null ? 4173 : Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("Port must be an integer from 1 to 65535.");
  const store = new BrainStore(defaultDbPath());
  const openedBrain = flagValue(args, "--brain");
  const brainId = openedBrain ? resolveBrainArg(store, openedBrain) : undefined;
  let server;
  try {
    server = await startViewer(store, port);
  } catch (error) {
    store.close();
    if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
      fail(`Port ${port} is already in use. Re-run with --port <n>.`);
    }
    throw error;
  }
  const url = brainId ? `http://127.0.0.1:${port}/brain?brain=${encodeURIComponent(brainId)}` : `http://127.0.0.1:${port}`;
  console.log(`Brain list  ${url}`);
  console.log(`Database    ${defaultDbPath()}`);
  console.log("Press Ctrl+C to stop.");
  if (!args.includes("--no-open")) openBrowser(url);
  const shutdown = () => {
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;

  if (!command || command === "serve") return serve();
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === "init") return init(args);
  if (command === "import") return importCommand(args);
  if (command === "view") return viewCommand(args);
  if (command === "brains" || command === "agents") {
    const store = new BrainStore(defaultDbPath());
    try {
      if (command === "brains") brainsCommand(store, args);
      else agentsCommand(store, args);
    } finally {
      store.close();
    }
    return;
  }

  const brain = openBrain();
  try {
    switch (command) {
      case "export": {
        const target = positionals(args, ["--brain"])[0];
        const brainId = flagValue(args, "--brain") ? resolveBrainArg(brain.store, flagValue(args, "--brain")) : undefined;
        if (args.includes("--json")) {
          const file = path.resolve(target ?? "make0-brain-bundle.json");
          const bundle = writeBundle(brain.store, file, brainId);
          console.log(`Wrote ${bundle.memories.length} memories, ${bundle.versions.length} versions, ${bundle.edges.length} links to ${file}`);
        } else {
          const dir = path.resolve(target ?? "make0-brain-export");
          const { files } = writeMarkdownExport(brain.store, dir, brainId);
          console.log(`Wrote ${files} memories to ${dir}`);
        }
        break;
      }
      case "stats": {
        console.log(`Database:  ${defaultDbPath()}`);
        printStats(brain.store, flagValue(args, "--brain") ? resolveBrainArg(brain.store, flagValue(args, "--brain")) : undefined);
        break;
      }
      case "history": {
        const id = args[0] ?? fail("Usage: make0-brain history <id>");
        if (!brain.getMemory(id, { includeArchived: true })) fail(`Memory ${id} not found.`);
        for (const version of brain.getVersions(id)) {
          const marker = version.isCurrent ? "*" : " ";
          console.log(`${marker} v${version.versionNumber}  ${version.createdAt}  ${version.writtenBy}`);
          console.log(`    ${version.content.replace(/\n/g, "\n    ")}`);
        }
        break;
      }
      case "restore": {
        const id = args[0] ?? fail("Usage: make0-brain restore <id> [--version <n>]");
        const versionArg = flagValue(args, "--version");
        if (versionArg != null) {
          const memory = await brain.restoreVersion(id, Number(versionArg));
          if (!memory) fail(`Memory ${id} has no version ${versionArg}, or is archived.`);
          console.log(`Restored ${id} to version ${versionArg}.`);
        } else {
          if (!brain.restoreMemory(id)) fail(`Memory ${id} not found.`);
          console.log(`Restored ${id}.`);
        }
        break;
      }
      case "purge": {
        const id = args[0] ?? fail("Usage: make0-brain purge <id> --yes");
        if (!args.includes("--yes")) fail("Purge is permanent. Re-run with --yes to confirm.");
        if (!brain.purgeMemory(id)) fail(`Memory ${id} not found.`);
        console.log(`Permanently deleted ${id}.`);
        break;
      }
      default:
        fail(`Unknown command: ${command}\n\n${HELP}`);
    }
  } finally {
    brain.store.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exit(1);
});
