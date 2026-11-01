#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../package.json";
import { agentsCommand, brainsCommand, printStats, resolveBrainArg } from "./commands/brains";
import {
  agentAccessSteps,
  archivedPickSteps,
  brainCreateSteps,
  brainPickSteps,
  exportSteps,
  importBrainStep,
  importSourceSteps,
  mainMenuSteps,
  memoryPickSteps,
  type SessionPlan,
  sessionImportSteps,
} from "./commands/steps";
import { brainHome, defaultDbPath, localModelsFor, openBrain } from "./config";
import { loadEnvFiles } from "./env";
import { writeBundle, writeMarkdownExport } from "./export/export";
import { EXTRACT_NEEDS_LLM, runImport, stdinImportFile } from "./import/run";
import {
  agentLabel,
  collectSessionFiles,
  collectSessionFilesAsync,
  DEFAULT_SESSION_LIMIT,
  DEFAULT_SESSION_WINDOW_DAYS,
  parseSince,
  SESSION_AGENTS,
} from "./import/sessions";
import { collectImportFiles, detectAgentFiles, type ImportFile } from "./import/sources";
import { detectClients } from "./init/clients";
import { prefetchModels } from "./init/models";
import { runInit } from "./init/run";
import { promptForClients } from "./init/select";
import { resolveLlmConfig } from "./llm/client";
import { createBrainMcpServer } from "./mcp/server";
import { PERSONAL_BRAIN_ID } from "./shared/types";
import { BrainStore } from "./store/store";
import { canPrompt, clackSteps, type Steps, StepsCancelled, ui } from "./stepper";
import { startViewer } from "./view/server";

loadEnvFiles();

const HELP = `Make0 Brain ${version} — one memory for Claude, ChatGPT, Cursor, and every AI you use.

Usage:
  make0-brain                      Run the MCP server over stdio; typed in a terminal,
                                   it opens a menu of everything below instead
  make0-brain serve                Always run the MCP server, even in a terminal
  Commands typed in a terminal without their arguments ask for them step by step
  (import, import --sessions, brains create|edit|delete, agents grant|revoke,
  export, restore, purge, history). Pass the arguments or --yes to skip the steps.

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
  make0-brain import --sessions    Import coding-agent sessions from disk (Claude Code, Codex,
                                   Cursor, Copilot, Gemini, opencode, Cline, and 34 more),
                                   one digest per session (no API key needed)
      --since <30d|12h|2w|all>     Only sessions active in this window (default 30d)
      --limit <n|all>              At most n sessions, newest first (default 500)
      --agent <id,id…>             Only these agents (see --list-agents)
  make0-brain import --list-agents List the agents --sessions can read
      --extract                    Extract atomic facts with your API key or local model
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
  MAKE0_BRAIN_LLM_BASE_URL             OpenAI-compatible endpoint; a localhost one needs no key
                                   (Ollama: http://localhost:11434/v1)
  MAKE0_BRAIN_LLM_MODEL            Chat model (default gpt-6-luna; llama3.2 on localhost)
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

  if (canPrompt(args)) {
    return clackSteps()(2).multi(
      "Apps",
      "Connect which apps?",
      detected.map((client) => ({ label: client.name, value: client.id, id: client.id })),
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const picked = await promptForClients(detected, (question) => rl.question(question), (line) => console.log(line));
    return picked.map((client) => client.id);
  } finally {
    rl.close();
  }
}

async function init(args: string[]): Promise<void> {
  const framed = canPrompt(args);
  if (framed) ui.intro("connect your agents");
  const clientIds = await chooseInitClients(args);
  if (clientIds?.length === 0) {
    if (framed) return ui.cancel("Nothing changed.");
    console.log("Nothing changed.");
    return;
  }
  await runInit({
    env: { home: os.homedir(), platform: process.platform, appData: process.env.APPDATA },
    clientIds,
    rules: !args.includes("--no-rules"),
    dryRun: args.includes("--dry-run"),
    confirm: framed ? () => clackSteps()(2).confirm("Changes", ["The changes above are backed up to .make0-backup first."], "Apply these changes?") : () => confirm("\nApply these changes?", args, true),
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

async function importCommand(rawArgs: string[]): Promise<void> {
  if (rawArgs.includes("--list-agents")) {
    for (const agent of SESSION_AGENTS) console.log(`  ${agent.id.padEnd(14)} ${agent.label}`);
    return;
  }
  const interactive = canPrompt(rawArgs);
  let args = rawArgs;
  // The title bar is drawn once, by whichever step comes first.
  let framed = false;
  const valueFlags = ["--brain", "--since", "--agent", "--limit"];
  if (interactive && positionals(args, valueFlags).length === 0 && !args.includes("--sessions") && !args.includes("--detect")) {
    if (!framed) ui.intro("import");
    framed = true;
    const picked = await importSourceSteps(clackSteps());
    if (!picked) return ui.cancel("Nothing imported.");
    args = [...args, ...picked];
  }

  const targets = positionals(args, valueFlags);
  const files: ImportFile[] = [];
  let sessionBrain: SessionPlan["brain"] | undefined;
  if (args.includes("--sessions")) {
    const sinceArg = flagValue(args, "--since") ?? `${DEFAULT_SESSION_WINDOW_DAYS}d`;
    const since = sinceArg === "all" ? undefined : (parseSince(sinceArg) ?? fail(`--since takes 30d, 12h, 2w, or all, not ${sinceArg}`));
    const limitArg = flagValue(args, "--limit") ?? String(DEFAULT_SESSION_LIMIT);
    const limit = limitArg === "all" ? undefined : Number(limitArg);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) fail(`--limit takes a positive number or all, not ${limitArg}`);
    const agents = flagValue(args, "--agent")?.split(",").map((id) => id.trim()).filter(Boolean);
    const unknown = agents?.filter((id) => !SESSION_AGENTS.some((agent) => agent.id === id)) ?? [];
    if (unknown.length) fail(`Unknown agent: ${unknown.join(", ")}. See make0-brain import --list-agents.`);
    const windowLabel = sinceArg === "all" ? "all time" : `the last ${sinceArg.replace(/^(\d+)$/, "$1d")}`;
    const warnings: string[] = [];
    let sessions: ImportFile[];
    if (interactive) {
      if (!framed) ui.intro("import coding-agent sessions");
      framed = true;
      const spin = ui.spinner();
      spin.start(`Looking for sessions from ${windowLabel}`);
      // At a terminal the limit applies to the agents picked, so read the whole window first.
      sessions = await collectSessionFilesAsync({
        since,
        agents,
        warn: (line) => warnings.push(line),
        onProgress: (event) =>
          spin.message(
            event.phase === "finding"
              ? `Looking through ${agentLabel(event.agent)}`
              : `Reading ${agentLabel(event.agent)} sessions · ${event.done + 1} of ${event.total}`,
          ),
      });
      spin.stop(`Found ${sessions.length} session${sessions.length === 1 ? "" : "s"} from ${windowLabel}`);
      for (const line of warnings) ui.warn(line);
    } else {
      sessions = collectSessionFiles({ since, limit, agents, warn: (line) => console.error(`  ! ${line}`) });
    }
    if (sessions.length === 0) {
      const message = "No agent sessions found. See make0-brain import --list-agents for the agents that can be read.";
      if (interactive) return ui.outro(message);
      console.log(message);
    } else if (interactive) {
      const store = new BrainStore(defaultDbPath());
      try {
        const brainArg = flagValue(args, "--brain");
        const plan = await sessionImportSteps(clackSteps(), {
          files: sessions,
          store,
          askAgents: !agents,
          brainId: brainArg ? resolveBrainArg(store, brainArg) : undefined,
          windowLabel,
          limit,
        });
        if (!plan) return ui.cancel("Nothing imported.");
        sessions = plan.files;
        sessionBrain = plan.brain;
      } finally {
        store.close();
      }
    } else {
      const counts = new Map<string, number>();
      for (const file of sessions) counts.set(file.source.replace(/-session$/, ""), (counts.get(file.source.replace(/-session$/, "")) ?? 0) + 1);
      console.log(`Found ${sessions.length} session(s): ${[...counts].map(([id, count]) => `${agentLabel(id)} ${count}`).join(", ")}.`);
    }
    files.push(...sessions);
  }
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
    if (!args.includes("--detect") && !args.includes("--sessions")) {
      fail("Usage: make0-brain import <path…> | --detect | --sessions | -");
    }
    return;
  }
  const extract = args.includes("--extract");
  if (extract && !resolveLlmConfig()) fail(EXTRACT_NEEDS_LLM);

  const brain = openBrain();
  try {
    let brainId: string;
    if (sessionBrain && "create" in sessionBrain && args.includes("--dry-run")) {
      // A dry run changes nothing, the new brain included; plan against the personal brain.
      brainId = PERSONAL_BRAIN_ID;
      ui.info(`Would create the brain ${sessionBrain.create}.`);
    } else if (sessionBrain && "create" in sessionBrain) {
      brainId = brain.store.createBrain({ name: sessionBrain.create, description: "Coding-agent sessions" }).id;
      ui.success(`Created the brain ${sessionBrain.create}.`);
    } else if (sessionBrain) {
      brainId = sessionBrain.id;
    } else if (!flagValue(args, "--brain") && interactive) {
      if (!framed) ui.intro("import");
      framed = true;
      brainId = await importBrainStep(clackSteps(), brain.store);
    } else {
      brainId = resolveBrainArg(brain.store, flagValue(args, "--brain"));
    }
    // Inside the frame, progress shows on a spinner and the result as one closing line.
    const spin = framed ? ui.spinner() : null;
    spin?.start("Saving memories");
    let last = "";
    const summary = await runImport(brain, files, {
      brainId,
      extract,
      dryRun: args.includes("--dry-run"),
      // A stepper already asked; flags-only runs keep the size check.
      confirm: sessionBrain || framed ? async () => true : (text) => confirm(text, args),
      log: (line) => {
        if (!spin) return console.log(line);
        last = line.trim();
        spin.message(last);
      },
    });
    if (spin) {
      const name = brain.store.getBrain(brainId)?.name ?? brainId;
      if (args.includes("--dry-run")) {
        spin.stop("Dry run, nothing saved");
        ui.outro(last);
      } else {
        spin.stop(`${summary.added} added · ${summary.updated} updated · ${summary.unchanged} unchanged in ${name}`);
        ui.outro("See it with make0-brain view");
      }
    }
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

/** Local list view. Search uses the same hybrid retrieval as the MCP server. */
async function viewCommand(args: string[]): Promise<void> {
  const portArg = flagValue(args, "--port");
  const port = portArg == null ? 4173 : Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("Port must be an integer from 1 to 65535.");
  const brain = openBrain();
  const openedBrain = flagValue(args, "--brain");
  const brainId = openedBrain ? resolveBrainArg(brain.store, openedBrain) : undefined;
  let server;
  try {
    server = await startViewer(brain, port);
  } catch (error) {
    brain.store.close();
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
    brain.store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Run steps drawn by clack under a title bar. */
async function withSteps<T>(run: (make: Steps) => Promise<T>, title?: string): Promise<T> {
  ui.intro(title);
  return run(clackSteps());
}

/**
 * Commands run at a terminal without their arguments get a stepper that
 * asks for them. Returns the arguments to run with, or null to stop.
 */
async function fillArgs(command: string, args: string[]): Promise<string[] | null> {
  if (!canPrompt(args)) return args;
  const [action, ...rest] = args;
  const store = () => new BrainStore(defaultDbPath());
  const using = async (flow: (make: Steps, db: BrainStore) => Promise<string[] | null>) => {
    const db = store();
    try {
      return await withSteps((make) => flow(make, db), `${command}${action && !action.startsWith("-") ? ` ${action}` : ""}`);
    } finally {
      db.close();
    }
  };
  if (command === "brains") {
    if (action === "create" && positionals(rest, ["--description", "--emoji", "--agents"]).length === 0) return using(brainCreateSteps);
    if ((action === "edit" || action === "delete") && positionals(rest, ["--name", "--description", "--emoji"]).length === 0) {
      return using((make, db) => brainPickSteps(make, db, action));
    }
    if (action === "delete" && !rest.includes("--yes")) {
      const ok = await withSteps((make) => confirmStep(make, `Delete brain ${rest[0]} and its memories? This cannot be undone.`), "brains delete");
      return ok ? [...args, "--yes"] : null;
    }
  }
  if (command === "agents" && (action === "grant" || action === "revoke")) {
    const [clientId, ...refs] = positionals(rest);
    if (refs.length === 0) return using((make, db) => agentAccessSteps(make, db, action, clientId));
  }
  if (command === "export" && positionals(args, ["--brain"]).length === 0 && !args.includes("--json")) return using(exportSteps);
  if ((command === "restore" || command === "purge") && !args[0]) return using((make, db) => archivedPickSteps(make, db, command));
  if (command === "purge" && !args.includes("--yes")) {
    const ok = await withSteps((make) => confirmStep(make, `Permanently delete ${args[0]} and every version of it? This cannot be undone.`), "purge");
    return ok ? [...args, "--yes"] : null;
  }
  if (command === "history" && !args[0]) return using(memoryPickSteps);
  return args;
}

async function confirmStep(make: Steps, question: string): Promise<boolean> {
  return make(1).confirm("Confirm", [question], "Go ahead?", false);
}

async function main(argv: string[]): Promise<void> {
  // `make0-brain` typed at a terminal opens a menu. MCP clients start it without a
  // terminal (stdin is their pipe), so they still get the server.
  if (argv.length === 0 && canPrompt()) {
    const picked = await withSteps(mainMenuSteps, "one memory for every AI you use");
    if (!picked) return ui.outro("See you next time.");
    argv = picked;
  }
  const [command, ...rawArgs] = argv;

  if (!command || command === "serve") return serve();
  const filled = ["brains", "agents", "export", "restore", "purge", "history"].includes(command) ? await fillArgs(command, rawArgs) : rawArgs;
  if (!filled) return ui.cancel("Nothing changed.");
  const args = filled;
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
  if (error instanceof StepsCancelled) {
    ui.cancel();
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});
