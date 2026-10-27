import { spawnSync } from "node:child_process";
import {
  applyChange,
  type ConfigChange,
  detectClients,
  type InitEnv,
  MAKE0_SYSTEM_INSTRUCTION,
  MCP_CLIENTS,
  type McpClient,
  planConfigChange,
  planRulesChange,
  SERVER_NAME,
  stdioServer,
} from "./clients";

export type InitOptions = {
  env: InitEnv;
  /** Limit to these client ids; default every detected client. */
  clientIds?: string[];
  rules?: boolean;
  dryRun?: boolean;
  /** Asked once with the plan; false aborts. */
  confirm: (plan: string) => Promise<boolean>;
  log: (line: string) => void;
  /** Runs `claude mcp …`; injectable for tests. Null when the CLI is missing. */
  claudeCli?: ((args: string[]) => { status: number | null }) | null;
};

type PlannedClient = {
  client: McpClient;
  /** Claude Code rewrites ~/.claude.json while running, so prefer its CLI. */
  viaCli: boolean;
  config?: ConfigChange;
  rules?: ConfigChange;
};

function defaultClaudeCli(): InitOptions["claudeCli"] {
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  if (probe.status !== 0) return null;
  return (args) => spawnSync("claude", args, { stdio: "ignore", shell: process.platform === "win32" });
}

export async function runInit(options: InitOptions): Promise<{ configured: string[] }> {
  const { env, log } = options;
  const known = new Map(MCP_CLIENTS.map((client) => [client.id, client]));
  const unknown = (options.clientIds ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown client: ${unknown.join(", ")}. Known: ${[...known.keys()].join(", ")}`);
  }
  const clients = options.clientIds
    ? options.clientIds.map((id) => known.get(id)!)
    : detectClients(env);
  if (clients.length === 0) {
    log("No supported MCP clients found. Add it by hand:");
    log(`  command: ${[stdioServer(env.platform).command, ...stdioServer(env.platform).args].join(" ")}`);
    return { configured: [] };
  }

  const claudeCli = options.claudeCli === undefined ? defaultClaudeCli() : options.claudeCli;
  const planned: PlannedClient[] = clients.map((client) => {
    const viaCli = client.id === "claude-code" && claudeCli != null;
    return {
      client,
      viaCli,
      config: viaCli ? undefined : planConfigChange(client, env),
      rules: options.rules !== false && client.rulesPath ? planRulesChange(client.rulesPath(env)) : undefined,
    };
  });

  const lines = ["Make0 Brain will be added to:"];
  for (const { client, viaCli, config, rules } of planned) {
    const target = viaCli ? "claude mcp add --scope user" : `${config!.file} (${config!.status})`;
    lines.push(`  • ${client.name}: ${target}`);
    if (rules) lines.push(`      rule → ${rules.file} (${rules.status})`);
  }
  log(lines.join("\n"));

  if (options.dryRun) return { configured: [] };
  if (!(await options.confirm(lines.join("\n")))) {
    log("Nothing changed.");
    return { configured: [] };
  }

  const configured: string[] = [];
  const server = stdioServer(env.platform);
  for (const { client, viaCli, config, rules } of planned) {
    try {
      if (viaCli) {
        claudeCli!(["mcp", "remove", "--scope", "user", SERVER_NAME]);
        const result = claudeCli!(["mcp", "add", "--scope", "user", SERVER_NAME, "--", server.command, ...server.args]);
        if (result.status !== 0) throw new Error("claude mcp add failed");
      } else if (config) {
        applyChange(config);
      }
      if (rules) applyChange(rules);
      configured.push(client.id);
    } catch (error) {
      log(`  ✗ ${client.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`\nDone. Restart ${configured.length === 1 ? "the app" : "the apps"} to load Make0 Brain.`);
  const hints = planned.filter(({ client }) => configured.includes(client.id) && client.rulesHint);
  if (options.rules !== false && hints.length > 0) {
    log("\nThese apps keep rules in settings. Paste this so they search Brain first:");
    log(`  ${hints.map(({ client }) => client.rulesHint).join("\n  ")}`);
    log(`\n  "${MAKE0_SYSTEM_INSTRUCTION}"`);
  }
  return { configured };
}
