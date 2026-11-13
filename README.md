# Make0 Brain: shared AI memory for every agent

**One AI memory for every agent you use.** Claude Code, Claude Desktop, Cursor, Codex, Windsurf, VS Code, Gemini CLI, Hermes Agent, and OpenClaw all read and write the same memory, and every change is versioned.

A local-first, open-source AI memory server for [MCP](https://modelcontextprotocol.io). After a one-time model download it runs offline with no API key, keeps everything in one SQLite file on your machine, and speaks the same 7 tools as the hosted [Make0](https://make0.ai) Brain. It can also start full: one command imports the sessions 41 coding agents already keep on disk.

[Make0](https://make0.ai) · [SWE-ContextBench results](https://make0.ai/benchmarks/swe-contextbench) · [LongMemEval results](#longmemeval)

<p align="center">
  <a href="https://github.com/make0-official/brain-oss/actions/workflows/ci.yml"><img src="https://github.com/make0-official/brain-oss/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@make0-ai/brain"><img src="https://img.shields.io/npm/v/@make0-ai/brain" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@make0-ai/brain"><img src="https://img.shields.io/npm/dm/@make0-ai/brain" alt="npm downloads per month"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/make0-official/brain-oss" alt="MIT license"></a>
  <a href="package.json"><img src="https://img.shields.io/node/v/@make0-ai/brain" alt="Node.js 22 or later"></a>
</p>

<p align="center">
  <a href="https://mcprush.com/to/make0-brain-mcp?ref=badge"><img src="https://mcprush.com/badge/make0-brain-mcp/score.svg" alt="Make0 Brain MCP on mcprush"></a>
  <a href="https://glama.ai/mcp/servers/make0-official/brain-oss"><img src="https://glama.ai/mcp/servers/make0-official/brain-oss/badges/score.svg" alt="Make0 Brain MCP server on Glama"></a>
  <a href="https://mcpservers.org/servers/make0-official/brain-oss"><img src="https://mcpservers.org/badge.svg" alt="Listed on mcpservers.org"></a>
</p>

```bash
npx @make0-ai/brain init
```

Only using Cursor or VS Code? These buttons add the server to that one app. Run `init` too if you want it to download the models up front and write the custom instruction.

<p align="center">
  <a href="https://cursor.com/en/install-mcp?name=make0-brain&amp;config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtYWtlMC1haS9icmFpbiJdfQ%3D%3D"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/deeplink/mcp-install-light.svg"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add Make0 Brain to Cursor" height="32"></picture></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=make0-brain&amp;config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40make0-ai%2Fbrain%22%5D%7D"><img src="https://img.shields.io/badge/VS_Code-Install_Make0_Brain-0098FF?style=for-the-badge" alt="Install Make0 Brain in VS Code" height="32"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=make0-brain&amp;config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40make0-ai%2Fbrain%22%5D%7D&amp;quality=insiders"><img src="https://img.shields.io/badge/VS_Code_Insiders-Install_Make0_Brain-24bfa5?style=for-the-badge" alt="Install Make0 Brain in VS Code Insiders" height="32"></a>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=YXV0Hje9BvE">
    <img src="docs/images/demo.jpg" alt="Watch the Make0 Brain demo" width="720">
  </a>
</p>

---

## Why

Every agent keeps its own memory. Claude has `CLAUDE.md`, Cursor has rules, Codex has `AGENTS.md`, ChatGPT has its memory page. You end up explaining your stack, your preferences, and last week's decisions again in each one, and the copies drift apart.

Make0 Brain is one memory that all of them share:

- **Tell one agent, every agent knows.** A fact saved from Cursor is found by Claude Code in the next session.
- **Nothing is overwritten silently.** Every edit, from any agent, is kept as a version with who wrote it and when.
- **It stays yours.** One SQLite file on your machine, MIT licensed, exportable to plain Markdown.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/make0-official/brain-oss/raw/main/docs/images/how-it-works-dark.png">
    <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/how-it-works-light.png" alt="How Make0 Brain works: Cursor saves a memory into one local Brain, versioned with its writer; Claude Code, Codex, Gemini CLI, and Windsurf connect to the same Brain over MCP and find it in their next session">
  </picture>
</p>

## Quick start

**1. Connect your agents.**

```bash
npx @make0-ai/brain init
```

`init` finds Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Codex CLI, Gemini CLI, Hermes Agent, and OpenClaw. When more than one is installed, it shows a checklist of them, all ticked; untick any you want to leave out. Pass `--clients` to choose up front, or `--yes` to configure every detected agent without asking. It then shows what it will change, asks once, keeps a `.make0-backup` of each config file, and adds Make0 Brain to each chosen app. It downloads the two local models (about 50 MB, once) with a progress bar, so your first question to an agent doesn't wait on a download. Restart the apps afterwards.

Connecting the server is not enough. The agent also needs a custom instruction so it searches Brain before answering and saves lasting facts there. `init` writes this into the global rules file for Claude Code (`~/.claude/CLAUDE.md`), Codex (`~/.codex/AGENTS.md`), Gemini (`~/.gemini/GEMINI.md`), and Windsurf. Cursor, Claude Desktop, VS Code, Hermes Agent, and OpenClaw keep rules in settings or a persona file, so `init` prints the same text for you to paste:

```text
Make0 Brain is my source of truth for durable memory. Always search it before answering about me, my work, people, preferences, or past decisions. Save lasting facts and decisions to Brain. Never guess or invent memories. Use Brain exclusively for durable memory.
```

| App            | Where it goes                                            |
| -------------- | -------------------------------------------------------- |
| Claude Code    | `~/.claude/CLAUDE.md`, written by `init`                 |
| Codex CLI      | `~/.codex/AGENTS.md`, written by `init`                  |
| Gemini CLI     | `~/.gemini/GEMINI.md`, written by `init`                 |
| Windsurf       | Global rules, written by `init`                          |
| Cursor         | Settings → Rules → User Rules. Paste it.                 |
| Claude Desktop | Settings → Profile → personal preferences. Paste it.     |
| VS Code        | `.github/copilot-instructions.md` in the repo. Paste it. |
| Hermes Agent   | `~/.hermes/SOUL.md`. Paste it.                           |
| OpenClaw       | `~/.openclaw/workspace/AGENTS.md`. Paste it.             |

Skip the rule with `init --no-rules`.

**2. Bring in the context you already have.**

```bash
npx @make0-ai/brain import --detect             # CLAUDE.md, AGENTS.md, Cursor/Windsurf/Copilot rules
npx @make0-ai/brain import --sessions           # past sessions from 41 coding agents, one digest each
npx @make0-ai/brain import ~/Documents/MyVault  # an Obsidian vault or any Markdown folder
pbpaste | npx @make0-ai/brain import -          # e.g. a memory dump copied from ChatGPT
```

`import` on its own asks what to import. The details are under [Import and export](#import-and-export).

**3. Look at it.**

```bash
npx @make0-ai/brain view
```

The viewer opens on `127.0.0.1` with every brain, how many memories each holds, and what your apps retrieved and added this week.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-brains-dark.png">
    <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-brains-light.png" alt="The Make0 Brain viewer home: four brains (Personal, Acme Checkout, Trailhead, Reading notes) with memory counts and the apps that use each, next to totals, a 7-day activity chart, and the connected apps">
  </picture>
</p>

Models live in `~/.make0/models` and data in `~/.make0/brain.db`. If you skip `init` (or pass `--no-models`), the first save or search downloads the models instead.

### Or run it without arguments

Typed in a terminal, `npx @make0-ai/brain` opens a menu: connect agents, import sessions or notes, open the viewer, create a brain, choose which brains an app can use, export, restore an archived memory, or show stats. Any command run without its arguments asks for them the same way, one step at a time, with arrow keys, checkboxes, and a default on Enter. Ctrl+C cancels without changing anything.

Scripts and MCP clients are unaffected. Passing the arguments, adding `--yes`, or running without a terminal skips every question, and MCP clients, which start the server without a terminal, get the server as before. `make0-brain serve` starts the server even in a terminal.

<p align="center">
  <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/cli-menu.png" alt="The Make0 Brain menu in a terminal: connect agents, import coding-agent sessions, import notes, open the viewer, create a brain, manage app access, export, restore, show stats, or quit" width="640">
</p>

### Verify it works

Restart the apps you connected, then check that a memory written by one agent reaches another:

1. **Save from one agent.** In Cursor (or any connected app), say: *"Remember that my test fruit is mango."* It should call `add_memory`.
2. **Find it from another.** In a new Claude Code session (or any other connected app), ask: *"What is my test fruit?"* It should call `search_brain` and answer "mango" without being told.
3. **Check who wrote it.** Run `npx @make0-ai/brain view`, open the personal brain, and click the memory. It shows **Added by Cursor** and a version timeline.

Delete the test memory in the viewer when you are done. If step 1 or 2 doesn't call a Brain tool, the app is missing the custom instruction above (Cursor, Claude Desktop, and VS Code need it pasted) or wasn't restarted. Run `npx @make0-ai/brain agents` to confirm the app can use the personal brain.

## Import directly from

Your coding agents already keep every session on disk. One command reads that history from 41 agents and saves each session as a memory, filed under its project, so the next agent can find what was asked, decided, changed, and broken last time. No API key and no model are needed.

```bash
npx @make0-ai/brain import --sessions                          # pick agents and a brain step by step
npx @make0-ai/brain import --sessions --agent cursor,codex     # only these agents
npx @make0-ai/brain import --list-agents                       # agent ids and names
```

<table>
  <tr><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/claude-code.svg" width="40" height="40" alt="Claude Code"><br><sub>Claude Code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/codex.svg" width="40" height="40" alt="Codex"><br><sub>Codex</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/cursor.svg" width="40" height="40" alt="Cursor"><br><sub>Cursor</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/copilot-chat.svg" width="40" height="40" alt="VS Code Copilot Chat"><br><sub>VS Code Copilot Chat</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/copilot.svg" width="40" height="40" alt="Copilot CLI"><br><sub>Copilot CLI</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/gemini.svg" width="40" height="40" alt="Gemini CLI"><br><sub>Gemini CLI</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/antigravity.svg" width="40" height="40" alt="Antigravity"><br><sub>Antigravity</sub></td></tr>
  <tr><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/opencode.svg" width="40" height="40" alt="opencode"><br><sub>opencode</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/cline.svg" width="40" height="40" alt="Cline"><br><sub>Cline</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/roo.svg" width="40" height="40" alt="Roo Code"><br><sub>Roo Code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/kilocode.svg" width="40" height="40" alt="Kilo Code"><br><sub>Kilo Code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/continue.svg" width="40" height="40" alt="Continue"><br><sub>Continue</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/aider.svg" width="40" height="40" alt="aider"><br><sub>aider</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/amp.svg" width="40" height="40" alt="Amp"><br><sub>Amp</sub></td></tr>
  <tr><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/goose.svg" width="40" height="40" alt="Goose"><br><sub>Goose</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/crush.svg" width="40" height="40" alt="Crush"><br><sub>Crush</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/zed.svg" width="40" height="40" alt="Zed"><br><sub>Zed</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/hermes.svg" width="40" height="40" alt="Hermes"><br><sub>Hermes</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/openclaw.svg" width="40" height="40" alt="OpenClaw"><br><sub>OpenClaw</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/pi.svg" width="40" height="40" alt="pi"><br><sub>pi</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/omp.svg" width="40" height="40" alt="omp"><br><sub>omp</sub></td></tr>
  <tr><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/senpi.svg" width="40" height="40" alt="Senpi"><br><sub>Senpi</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/gjc.svg" width="40" height="40" alt="gajae-code"><br><sub>gajae-code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/kimchi.svg" width="40" height="40" alt="Kimchi"><br><sub>Kimchi</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/prime.svg" width="40" height="40" alt="prime-agent"><br><sub>prime-agent</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/qwen.svg" width="40" height="40" alt="Qwen Code"><br><sub>Qwen Code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/kimi.svg" width="40" height="40" alt="Kimi Code"><br><sub>Kimi Code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/kiro.svg" width="40" height="40" alt="Kiro"><br><sub>Kiro</sub></td></tr>
  <tr><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/junie.svg" width="40" height="40" alt="Junie"><br><sub>Junie</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/devin.svg" width="40" height="40" alt="Devin CLI"><br><sub>Devin CLI</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/deepseek.svg" width="40" height="40" alt="DeepSeek Harness"><br><sub>DeepSeek Harness</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/codewhale.svg" width="40" height="40" alt="CodeWhale"><br><sub>CodeWhale</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/codebuddy.svg" width="40" height="40" alt="CodeBuddy"><br><sub>CodeBuddy</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/commandcode.svg" width="40" height="40" alt="Command Code"><br><sub>Command Code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/zcode.svg" width="40" height="40" alt="ZCode"><br><sub>ZCode</sub></td></tr>
  <tr><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/reasonix.svg" width="40" height="40" alt="Reasonix"><br><sub>Reasonix</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/trae.svg" width="40" height="40" alt="TRAE CLI"><br><sub>TRAE CLI</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/muse.svg" width="40" height="40" alt="Muse Code"><br><sub>Muse Code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/mcode.svg" width="40" height="40" alt="MiniMax Code"><br><sub>MiniMax Code</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/grok.svg" width="40" height="40" alt="Grok Build"><br><sub>Grok Build</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/cherrystudio.svg" width="40" height="40" alt="Cherry Studio"><br><sub>Cherry Studio</sub></td><td align="center" width="110"><img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/agents/mcp.svg" width="40" height="40" alt="Any MCP agent"><br><sub>Any MCP agent</sub></td></tr>
</table>

<p align="center">
  <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/cli-sessions-import.png" alt="import --sessions in a terminal: it finds 160 sessions from the last 30 days, the person picks Claude Code, Codex and OpenClaw, creates a brain named Agent sessions, confirms a summary of 45 sessions, and the import reports 45 added" width="640">
</p>

In a terminal it asks three things: which of the agents it found to import, which brain to save into (or a new one), and whether the summary is right. Each memory is a digest of one session: what you asked, your corrections, the files that changed, the commands that failed, and how it ended. Credentials are redacted before anything is saved. [Coding-agent sessions](#coding-agent-sessions) covers the time window, the session cap, scripting flags, and the stores that cannot be read.

## One context across all agents

### Same tools in every app

After `init`, every connected agent gets the same 7 tools:

| Tool                  | What the agent uses it for                                      |
| --------------------- | --------------------------------------------------------------- |
| `list_brains`         | Get the brain ids this app can use. `personal` is always there until you allocate others. |
| `search_brain`        | Find memories for a focused query before answering.             |
| `get_memory`          | Read one memory in full.                                        |
| `get_memory_versions` | Read every saved version of a memory, newest first.             |
| `add_memory`          | Save a fact or a short Markdown note when you ask it to.        |
| `update_memory`       | Change a memory. The previous text is kept as a version.        |
| `delete_memory`       | Archive a memory. Its versions are kept and you can restore it. |

The names and schemas match the hosted Make0 Brain, so a prompt or agent setup works against either one.

### More than one brain

The personal brain is created with the database and cannot be deleted. Add others when a project should not share those memories:

```bash
npx @make0-ai/brain brains create "Work" --description "Client work" --agents cursor,claude-code
npx @make0-ai/brain brains                 # list brains
npx @make0-ai/brain agents                 # which app can use which brain
npx @make0-ai/brain import ~/Notes --brain Work
npx @make0-ai/brain view --brain Work
```

An app with no allocation sees only `personal`. `agents grant` and `agents revoke` change that, and so does the Connect dialog in `view`. Revoking every brain leaves the app with none: `list_brains` comes back empty until you grant one again. The viewer and the CLI can open every brain. Agents only see brains you give them, and `list_brains` is how they learn the id to pass to the other tools.

Open a brain to see its memories as a board, one column per category, with the app that wrote each one.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-board-dark.png">
    <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-board-light.png" alt="The Acme Checkout brain as a board: Payments, Decisions, Environments, and People columns, each memory marked with the app that wrote it">
  </picture>
</p>

### Every memory knows who wrote it

Make0 Brain reads the client name each app sends when it connects and records it as the writer: `claude`, `chatgpt`, or `cursor`. Any other app is recorded as `mcp`, with its own client name kept too. Search results show `addedBy` for each memory, and every version records who wrote it. You can see which agent learned what.

### See what each app reads and writes

Every memory an app retrieves or writes is counted per app and per brain, with a rough token count. The home page shows this week at a glance; **Details** opens the full chart, filterable by brain, range, and app, in memories, tokens, or average tokens per call. The counters stay in the local database.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-activity-dark.png">
    <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-activity-light.png" alt="Brain activity for the last 7 days: 1,320 memories retrieved and 110 added, a daily chart, and a breakdown by Claude Code, Cursor, Codex CLI, Claude Desktop, and Gemini CLI">
  </picture>
</p>

### Context stays consistent

- **Contradictions replace older facts.** If Cursor saves "I don't like dark mode in my editor" after Claude saved "I like dark mode in my editor", the newer memory wins and the older one is archived, with its history intact.
- **Duplicates merge (with an API key or a local model).** An LLM judge compares close matches and merges restatements into one memory. The merged text may only use words from the two originals, so it cannot invent facts. Without one, duplicates are kept rather than guessed at.
- **Related memories are linked.** Similar memories get links automatically, and search follows them up to two hops, so asking about a project also surfaces the decisions tied to it.

Switch a brain to **3D** to orbit and zoom through it: categories branch from the center, and each memory sits on its category.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-graph-dark.png">
    <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-graph-light.png" alt="3D view of the personal brain: 35 memories grouped into categories such as Tooling, Coding style, Infrastructure, Security, and About me">
  </picture>
</p>

## Memory versioning

Every write to a memory creates a version, whether it comes from an agent, an import, or you in the viewer. Nothing is overwritten in place.

### What a version records

| Field                                                     | Meaning                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `versionNumber`                                           | 1, 2, 3… per memory.                                               |
| `current`                                                 | The version agents read now. Exactly one per memory.               |
| `content`, `category`, `kind`, `entityType`, `confidence` | The memory as it was at that point.                                |
| `writtenBy`                                               | `user`, `make0`, `claude`, `chatgpt`, `cursor`, or `mcp`.          |
| `writerName`                                              | The app's own client name when `writtenBy` is the generic `mcp`.   |
| `embeddingModel`                                          | The embedder that indexed the text while this version was current. |
| `createdAt`                                               | When the version was written.                                      |

A version is written when the content, category, kind, or entity type changes. A confidence-only change does not add one.

### Agents can read the history

Search results include `versionCount`. When it is greater than 1, an agent can call `get_memory_versions` to see how a fact changed and who changed it: for example, that you switched from npm to pnpm last month and which agent recorded it.

### Nothing is lost

| Action                                   | What happens                                           |
| ---------------------------------------- | ------------------------------------------------------ |
| `update_memory` or an edit in the viewer | A new current version. Older versions stay.            |
| A contradicting or merged memory         | The older memory is archived with all its versions.    |
| `delete_memory`                          | Archived: hidden from search and reads, versions kept. |
| Re-import of an edited note              | A new version of that memory, not a duplicate.         |
| Re-import of a note you deleted          | Skipped. Deleted stays deleted.                        |
| `make0-brain purge <id> --yes`           | The only permanent delete. Agents cannot do it.        |

### Browse and restore

```bash
npx @make0-ai/brain history <id>               # every version, current one marked *
npx @make0-ai/brain restore <id> --version 2   # make version 2 current again
npx @make0-ai/brain restore <id>               # bring back an archived memory
```

```text
* v3  2026-10-27T09:14:02.118Z  claude
    The project uses pnpm and Node 22.
  v2  2026-10-20T16:40:51.502Z  cursor
    The project uses pnpm.
  v1  2026-10-02T11:05:33.910Z  user
    The project uses npm.
```

Restoring makes an older version current again and re-indexes it. No version is deleted.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-versions-dark.png">
    <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/viewer-versions-light.png" alt="A memory open in the viewer: its text can be edited, and its version timeline shows v3 by Claude as current, with v2 by Cursor and v1 by Claude available to make current again">
  </picture>
</p>

`npx @make0-ai/brain view` opens a local page (on `127.0.0.1` only) where you can create and switch brains, browse memories as a board or in 3D, search, add, and edit them, read each memory's version timeline, restore a version, bring back archived memories, inspect the stored embedding, and permanently delete.

## Search quality

Measured on [SWE-ContextBench](https://arxiv.org/abs/2602.08316) Lite, the same comparison as the [Make0 benchmark page](https://make0.ai/benchmarks/swe-contextbench): 300 earlier coding sessions and 99 related issues. The score is how often search returns the gold past session. The local install uses the offline MiniLM embedder and the ms-marco MiniLM reranker. Once the models are loaded, search takes about **60ms** per query on an Apple M2 Pro with 300 short memories, and about **430ms** in this benchmark, where each query is a whole GitHub issue and each memory a full coding session.

Rank 1, the gold session is the first result:

```text
Make0 Brain (cloud)   █████████████████████████████░░░░░░░░░░░  71.7%
Make0 Brain (local)   █████████████████████████░░░░░░░░░░░░░░░  62.6%  ~430ms
LangMem               ██████████████████████░░░░░░░░░░░░░░░░░░  55.6%
OpenViking            ███████████████░░░░░░░░░░░░░░░░░░░░░░░░░  38.4%
Free summary search   ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░  34.3%
Mem0                  ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  25.3%
Supermemory           █████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  23.2%
```

Overall, the gold session appears anywhere in the results:

```text
Make0 Brain (cloud)   ██████████████████████████████████████░░  93.9%  top 10
Make0 Brain (local)   █████████████████████████████████████░░░  92.9%  top 10   ~430ms
LangMem               █████████████████████████████░░░░░░░░░░░  73.3%  top 10
Supermemory           ████████████████████████░░░░░░░░░░░░░░░░  59.6%  top 15
OpenViking            █████████████████████░░░░░░░░░░░░░░░░░░░  51.5%  top 3
Mem0                  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░  39.4%  top 3
Free summary search   ███████████████░░░░░░░░░░░░░░░░░░░░░░░░░  36.4%  agent chooses
```

LangMem, OpenViking, Mem0, Supermemory, and free summary search are from Table 5 of that paper. "Overall" counts a hit anywhere in each system's own result list; Make0 cloud, Make0 Brain, and LangMem each return 10. On the full benchmark (1,007 past tasks, 357 related issues), hosted Make0 scores 71.4% at rank 1 and 88.2% overall. A stronger embedder and reranker raise accuracy.

How search works: MiniLM embeddings and BM25 keyword scores are blended, a cross-encoder reranks the shortlist (or an LLM filter, with a key), weak results are pruned, and the top results are expanded two hops along memory links.

### LongMemEval

Measured on [LongMemEval](https://arxiv.org/abs/2410.10813)\_S with the open-source local install. Each question comes with its own history of past chat sessions, and the score is how often search returns the session that holds the answer. Overall covers the 470 standard questions. The 30 abstention questions, which ask about something the history never says, are scored on their own in the last row.

| Question type               |  Recall@5 | Recall@10 |       MRR |
| --------------------------- | --------: | --------: | --------: |
| **Overall**                 | **93.9%** | **96.2%** | **0.941** |
| Knowledge update            |     99.3% |     99.3% |     0.986 |
| Multi-session               |     90.0% |     93.0% |     0.959 |
| Single-session assistant    |      100% |      100% |     1.000 |
| Single-session preference   |     90.0% |     96.7% |     0.717 |
| Single-session user         |      100% |      100% |     0.965 |
| Temporal reasoning          |     89.8% |     93.6% |     0.914 |
| Abstention (not in Overall) |     90.6% |     90.6% |     0.944 |

## Import and export

### Import

- **Folders and vaults.** Each note becomes one memory. Long notes split by heading, and each part keeps the note title. Frontmatter tags or the folder name become the category. Obsidian `[[wikilinks]]` become links between memories. `.obsidian/` and `.trash/` are skipped.
- **Agent rule files.** `--detect` finds the rule files you already wrote for one agent (global ones under your home folder, project ones in the current folder) and makes them available to all of them. Make0 Brain's own "search Brain first" block is stripped out, so it is never imported as a memory.
- **Coding-agent sessions.** `--sessions`; see [below](#coding-agent-sessions).
- **Re-runs are safe.** Unchanged items are skipped, edited ones get a new version, and memories you deleted stay deleted.
- **`--extract`** (needs an API key or a local model) turns files into one-fact memories instead of note-sized ones. With `--sessions` it keeps only what stays true after the session: your preferences and corrections, project decisions, and fixes for errors that may come back.
- **`--brain <id>`** picks the brain; at a terminal you are asked instead. `--dry-run` shows what would change without saving or creating anything. Imports over 200 memories ask first; `--yes` skips the question.

### Coding-agent sessions

`--sessions` reads the session history coding agents already keep on your machine and saves one memory per session, in a category per project (**Sessions · acme-api**), so the board shows a column per project. Each memory records what you asked, your corrections, the files that changed, the commands that failed with their first error line, and how the session ended. No model is involved, so it needs no key.

<p align="center">
  <img src="https://github.com/make0-official/brain-oss/raw/main/docs/images/cli-sessions-agents.png" alt="The agents step of import --sessions: Cursor 115 sessions unticked, Claude Code 39, Codex 5 and OpenClaw 1 ticked" width="560">
</p>

- **At a terminal** it lists the agents it found, busiest first, all ticked; then asks for a brain, or creates one; then shows a summary to confirm. In scripts, `--agent cursor,claude-code` picks agents, `--brain <id>` the brain (default personal), and `--yes` skips the questions. `--list-agents` prints every agent id.
- **Time window and cap.** It reads the last 30 days and at most 500 sessions, the most recently active first. `--since 2w` or `--since all` changes the window, and `--limit 100` or `--limit all` the cap. Sessions outside them are never opened, so a large history (Cursor's database can pass 50 GB) costs a quick scan, not a full read.
- **Privacy.** API keys, tokens, private keys, passwords, and long random tokens are replaced with `[redacted:<kind>]` before anything is stored.
- **What is skipped.** Sessions with no prompt you typed, subagent runs, and files under temp folders. When an agent keeps one session in two places (Cursor's CLI transcript and its IDE database), it is imported once.
- **Re-running** picks up new sessions; a session that grew gets a new version.
- **Agents read:** the 41 under [Import directly from](#import-directly-from).
- **Not read:** Windsurf and TRAE IDE (their chats are encrypted), JetBrains AI Assistant, Kiro's headless `data.sqlite3`, Reasonix 1.x frame logs, and Amp threads that live only on ampcode.com.
- **zstd.** Zed, DeepSeek Harness, and OpenClaw's compressed events are zstd-compressed. Node.js 22.15 or newer decompresses them itself; on older Node.js, Make0 Brain uses the `zstd` command when it is installed and otherwise skips those sessions.
- The store locations and record formats follow the session format registry in [deja-vu](https://github.com/vshulcz/deja-vu) (MIT).

### Export

```bash
npx @make0-ai/brain export ./my-brain          # one Markdown file per memory, opens as an Obsidian vault
npx @make0-ai/brain export --json brain.json   # every memory, version, and link (the Make0 port format)
```

The Markdown export imports back in. The JSON bundle includes archived memories and the full version history. It does not include embeddings; whoever reads it re-embeds with their own model.

## Optional API key or local model

Nothing needs a key. With one, Make0 Brain also merges duplicate memories, picks better categories, filters search results with an LLM, and can `import --extract`. A model running on your own machine can do the same work without a key.

Copy `.env.example` to `.env` in this folder, or to `~/.make0/.env` so every app shares one file:

```bash
cp .env.example ~/.make0/.env
```

```text
OPENAI_API_KEY=sk-...          # or OPENROUTER_API_KEY, or MAKE0_BRAIN_API_KEY
MAKE0_BRAIN_LLM_BASE_URL=      # any OpenAI-compatible endpoint (optional)
MAKE0_BRAIN_LLM_MODEL=         # default gpt-6-luna
MAKE0_BRAIN_EMBEDDINGS=api     # API embeddings instead of local MiniLM
MAKE0_BRAIN_LLM_SEARCH=0       # keep search on the local reranker
```

### Local model (Ollama, LM Studio, llama.cpp)

Point `MAKE0_BRAIN_LLM_BASE_URL` at a server on `localhost` and no key is needed. Nothing leaves your computer.

```bash
ollama pull llama3.2
```

```text
MAKE0_BRAIN_LLM_BASE_URL=http://localhost:11434/v1   # Ollama; LM Studio is http://localhost:1234/v1
MAKE0_BRAIN_LLM_MODEL=llama3.2                       # default llama3.2 on localhost
```

A local URL wins over a hosted key set in the same environment. A local model is slower than a hosted API, so its calls get five times longer to answer, and search stays on the fast local reranker unless you set `MAKE0_BRAIN_LLM_SEARCH=1`. Servers that reject OpenAI's JSON mode are asked again without it. A model of 7B parameters or more gives noticeably better merges and extractions than a 1B to 3B one.

`MAKE0_BRAIN_BASE_URL`, the name before 0.3, still works.

Make0 Brain reads `./.env`, then `.env` in the data folder (`MAKE0_BRAIN_HOME`, default `~/.make0`). A variable already set in the environment, including in an MCP client's `env` block, wins. Switching embedders is safe: memories indexed by another model are re-embedded on the next search.

## Privacy and security

### What leaves your machine

| When                                          | What is sent                                                     | To                                    |
| --------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `init`, or the first save or search           | Download requests for the two local models (no memory content)   | Hugging Face                          |
| Each launch through `npx`, which is how agents start Brain | A request for the latest release, and a download if there is a new one (no memory content) | npm registry |
| Saves and searches with no API key            | Nothing                                                          |                                       |
| With an API key: saves                        | The new memory and close matches, to merge duplicates and pick a category | Your provider (`MAKE0_BRAIN_LLM_BASE_URL`, default OpenAI) |
| With an API key: search (`MAKE0_BRAIN_LLM_SEARCH` not `0`) | The query and candidate memories, to filter results    | Your provider                         |
| With an API key: `import --extract`           | The full text of the imported files (for `--sessions`, the redacted digest) | Your provider                 |
| With a localhost `MAKE0_BRAIN_LLM_BASE_URL`   | The same as with an API key, but to a server on this machine     | Nothing leaves the machine            |
| `import --sessions` without `--extract`       | Nothing                                                          |                                       |
| `MAKE0_BRAIN_EMBEDDINGS=api`                  | The text of every memory and every query, to embed it            | Your provider                         |

Make0 Brain has no telemetry and does not contact Make0. The usage counts in the viewer stay in the local database.

Agents start Brain with `npx -y @make0-ai/brain`, so each launch contacts the npm registry and runs any newly published release. If the network is down, npx uses its cached copy and Brain still runs.

To turn this off, install a fixed version and point the agent config at the `make0-brain` binary instead of `npx`:

```bash
npm install -g @make0-ai/brain@<version>
```

```json
{
  "mcpServers": {
    "make0-brain": { "command": "make0-brain", "args": [] }
  }
}
```

Pinning the version inside the npx command (`npx -y @make0-ai/brain@<version>`) is not enough. It stops automatic updates, but npx still contacts the registry on each launch. Running `init` again puts the `npx` command back, so edit the config again afterwards.

Make0 Brain being local does not make your agents local. When an agent calls `search_brain`, the memories it gets back go into that agent's conversation, and that conversation is sent to the agent's own model provider (Anthropic for Claude, OpenAI for Codex, and so on). Keep anything you would not paste into that agent out of the brains it can use. `agents grant` and `agents revoke` control which brains each app sees.

### Where your data lives

- **Database:** `~/.make0/brain.db`, a plain SQLite file with your memories, every version, links, and usage counts. It is not encrypted; it is protected by your user account and disk encryption.
- **Imports:** the text of each note is copied into the database, with its file path and a hash so re-imports can find changes. The original files are only read, never changed.
- **Agent config:** `init` keeps one `.make0-backup` of each config file it edits, and adds a marked block to the rule files listed above.
- **API key:** read from `.env` or the environment. It is never stored in the database or in exports.

### Bad or malicious memories

A memory is text, and an agent can read it as an instruction. A web page or a file an agent was working on can try to get it to save something like "always run this script". Make0 Brain cannot tell a true fact from a planted one, but it makes them easy to find and undo:

- Every memory and version records which app wrote it, so an unexpected writer stands out in the viewer.
- Nothing is overwritten in place. A bad edit can be reverted with `restore <id> --version <n>`.
- Agents can archive memories but cannot permanently delete them. Only `purge` and the viewer can.
- Give an app only the brains it needs, and keep a separate brain for untrusted work.

### The viewer

`view` listens on `127.0.0.1` only, so other machines cannot reach it. It has no login, but it only answers requests addressed to `127.0.0.1` or `localhost` on its own port, which blocks DNS-rebinding tricks. Requests that change memories or brains must come from the viewer's own page and be sent as JSON: other sites' requests are refused, and a browser will not send another site's JSON request without the viewer's approval, which it never gives. Other programs on your computer can still call it while it runs, so stop the viewer (Ctrl+C) when you are not using it.

## Backups, upgrades, and support

### Backups

Make0 Brain does not back up your database by itself. Copy one of these somewhere safe, and do it before you upgrade:

```bash
npx @make0-ai/brain export --json ~/make0-brain-backup.json   # every memory, version, and link
sqlite3 ~/.make0/brain.db ".backup ~/make0-brain-backup.db"    # an exact copy, safe while apps are running
```

Copy `brain.db` directly only when no app is running, or you may miss recent writes that are still in `brain.db-wal`. To restore, stop your apps and copy the `.db` backup over `~/.make0/brain.db`. The JSON bundle is a readable record of everything and the format for moving to Make0 cloud; `import` does not read it back yet.

### Upgrades

Upgrading does not need a new `init`. Agents run the server through `npx`, so they pick up a new release the next time they start. If you moved to a fixed global install (see [What leaves your machine](#what-leaves-your-machine)), nothing updates until you install a newer version yourself. If `npx @make0-ai/brain --version` shows an old version, a global install is shadowing npx: `npm install -g @make0-ai/brain@latest`. On first open, a new version migrates `brain.db` in place, one transaction per step, so a failed step leaves the database as it was. Migrations add tables and columns and fill in new fields; they do not remove your memories. Older versions are not tested against a migrated database, so back up before upgrading if you might go back.

### Requirements and status

- **Node.js 22 or newer.**
- **Operating systems:** developed and tested on macOS. `init` knows the Linux and Windows config paths, but those platforms are not covered by automated tests yet. Reports are welcome.
- **Status:** pre-1.0. The 7 MCP tools match the hosted Make0 Brain and are kept stable. CLI flags and the viewer may still change between minor versions.
- **Known limits:** one machine, no sync between devices; one memory holds up to 4,000 characters; without an API key or a local model, duplicates are kept rather than merged; the viewer has no login (see above).

### Releases

Each release is published to [npm](https://www.npmjs.com/package/@make0-ai/brain) from GitHub Actions with [provenance](https://docs.npmjs.com/generating-provenance-statements), tagged `vX.Y.Z` in [GitHub Releases](https://github.com/make0-official/brain-oss/releases), and listed in the [MCP Registry](https://registry.modelcontextprotocol.io). [CHANGELOG.md](CHANGELOG.md) describes what changed. Patch releases are fixes. Minor releases can add features and database migrations.

### Reporting a problem

Open an issue at [github.com/make0-official/brain-oss/issues](https://github.com/make0-official/brain-oss/issues) with:

- the output of `npx @make0-ai/brain --version` and `npx @make0-ai/brain stats`;
- your OS, Node version, and the agent app involved;
- the command or prompt, and any error text.

Do not paste private memories or your `.env`. For a security problem, don't open an issue: report it privately as described in [SECURITY.md](SECURITY.md).

## Local or cloud

|              | This repo                              | Make0 cloud                                                       |
| ------------ | -------------------------------------- | ----------------------------------------------------------------- |
| **Best for** | Local agents, data on your machine     | Every device and web app, including ChatGPT and Claude on the web |
| **Setup**    | `npx @make0-ai/brain init`             | Sign in at [make0.ai](https://make0.ai)                           |
| **API key**  | None required                          | Make0 account                                                     |
| **Brains**   | Personal and custom                    | Personal, project, and custom brains                              |
| **Storage**  | `~/.make0/brain.db`                    | Hosted                                                            |
| **Search**   | MiniLM + BM25 + cross-encoder, ~60ms on an Apple M2 Pro with short memories | Stronger embedder and reranker                                    |

A one-command port from local to Make0 cloud is coming. The `export --json` bundle is the format it will use, with history and attribution included.

## Reference

### CLI

```text
make0-brain                      Run the MCP server over stdio; typed in a terminal, open the menu
make0-brain serve                Run the MCP server, even in a terminal
make0-brain init                 Add Make0 Brain to your AI apps and download the models (--dry-run, --yes, --clients, --no-rules, --no-models)
make0-brain import <path…>       Import files, folders, or a vault (--detect, -, --extract, --brain, --dry-run, --yes)
make0-brain import --sessions    Import coding-agent sessions (--agent, --since, --limit, --brain, --extract, --dry-run, --yes)
make0-brain import --list-agents List the agents --sessions can read
make0-brain export [dir]         Markdown export (--json [file] for the bundle, --brain to limit it)
make0-brain brains               List, create, edit, or delete brains
make0-brain agents               Show or change which brains each app can use (grant, revoke)
make0-brain view                 Open the memory viewer in a browser (--port, --no-open, --brain)
make0-brain stats                Show memory and link counts (--brain)
make0-brain history <id>         List saved versions of a memory
make0-brain restore <id>         Restore an archived memory (--version <n> for an older version)
make0-brain purge <id> --yes     Permanently delete a memory and its versions
```

At a terminal, a command missing its arguments asks for them: `import` asks what to import, `brains create` for a name, description and apps, `brains edit|delete`, `restore`, `purge`, and `history` let you pick from a list, `agents grant|revoke` asks for the app and brains, and `export` for the format and destination. `purge` and `brains delete` default to No. `init --clients` takes a comma-separated list of `claude-code`, `claude-desktop`, `cursor`, `windsurf`, `vscode`, `codex`, `gemini`, `hermes`, `openclaw`.

### Manual setup

If `init` doesn't cover your app, add a stdio server and paste the custom instruction from the quick start into that app's rules:

```json
{
  "mcpServers": {
    "make0-brain": { "command": "npx", "args": ["-y", "@make0-ai/brain"] }
  }
}
```

### Environment

| Variable                                                        | Default                                     | Purpose                                 |
| --------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| `MAKE0_BRAIN_HOME`                                              | `~/.make0`                                  | Data folder: database, models, `.env`.  |
| `MAKE0_BRAIN_DB`                                                | `$MAKE0_BRAIN_HOME/brain.db`                | Database file.                          |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `MAKE0_BRAIN_API_KEY` | unset                                       | Turns on the optional LLM features.     |
| `MAKE0_BRAIN_LLM_BASE_URL`                                      | OpenAI, or OpenRouter for an OpenRouter key | OpenAI-compatible endpoint. A localhost one needs no key. Formerly `MAKE0_BRAIN_BASE_URL`. |
| `MAKE0_BRAIN_LLM_MODEL`                                         | `gpt-6-luna`; `llama3.2` on localhost       | Chat model.                             |
| `MAKE0_BRAIN_EMBEDDINGS`                                        | `local`                                     | `local` (MiniLM) or `api`.              |
| `MAKE0_BRAIN_EMBEDDING_MODEL`                                   | `text-embedding-3-small`                    | Embedding model when `api`.             |
| `MAKE0_BRAIN_LLM_SEARCH`                                        | on with a key, off with a local model       | `0` keeps search on the local reranker; `1` sends it to a local model. |

## Develop

```bash
npm install
npm test            # fast suite, no model downloads
npm run test:models # real local models
npm run test:e2e    # build, then drive the stdio server
```

The viewer UI is a React app in `web/`, built into `dist/web` and served by `make0-brain view`.

```bash
npm run build:web                                   # once, so `npm run dev -- view` has a UI
MAKE0_BRAIN_DB=/tmp/try.db npm run dev -- view --no-open
npm run dev:web                                     # hot reload at http://localhost:5173, API proxied to :4173
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull requests and releases.

## Stargazers

<a href="https://star-history.com/#make0-official/brain-oss&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=make0-official/brain-oss&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=make0-official/brain-oss&type=Date" />
    <img alt="Star history chart for make0-official/brain-oss" src="https://api.star-history.com/svg?repos=make0-official/brain-oss&type=Date" />
  </picture>
</a>

## License

MIT
