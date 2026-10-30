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
  /** Download local models after configuring, so the first search is not a download. */
  prefetchModels?: () => Promise<unknown>;
  /** Runs `claude mcp …`; injectable for tests. Null when the CLI is missing. */
  claudeCli?: CliRunner | null;
  /** Runs `openclaw mcp …`; injectable for tests. Null when the CLI is missing. */
  openclawCli?: CliRunner | null;
};

type CliRunner = (args: string[]) => { status: number | null };

type PlannedClient = {
  client: McpClient;
  /** Claude Code rewrites ~/.claude.json while running and openclaw.json is JSON5, so prefer their CLIs. */
  viaCli: boolean;
  config?: ConfigChange;
  rules?: ConfigChange;
};

function defaultCli(command: string): CliRunner | null {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  if (probe.status !== 0) return null;
  return (args) => spawnSync(command, args, { stdio: "ignore", shell: process.platform === "win32" });
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
    if (!options.dryRun) await options.prefetchModels?.();
    return { configured: [] };
  }

  const claudeCli = options.claudeCli === undefined ? defaultCli("claude") : options.claudeCli;
  const wantsOpenclaw = clients.some((client) => client.id === "openclaw");
  const openclawCli = options.openclawCli !== undefined ? options.openclawCli : wantsOpenclaw ? defaultCli("openclaw") : null;
  const planned: PlannedClient[] = clients.map((client) => {
    const viaCli = (client.id === "claude-code" && claudeCli != null) || (client.id === "openclaw" && openclawCli != null);
    return {
      client,
      viaCli,
      config: viaCli ? undefined : planConfigChange(client, env),
      rules: options.rules !== false && client.rulesPath ? planRulesChange(client.rulesPath(env)) : undefined,
    };
  });

  const lines = ["Make0 Brain will be added to:"];
  for (const { client, viaCli, config, rules } of planned) {
    const target = viaCli
      ? client.id === "openclaw" ? `openclaw mcp set ${SERVER_NAME}` : "claude mcp add --scope user"
      : `${config!.file} (${config!.status})`;
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
      if (viaCli && client.id === "openclaw") {
        const result = openclawCli!(["mcp", "set", SERVER_NAME, JSON.stringify(server)]);
        if (result.status !== 0) throw new Error("openclaw mcp set failed");
      } else if (viaCli) {
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

  if (configured.length > 0) await options.prefetchModels?.();

  log(`\nDone. Restart ${configured.length === 1 ? "the app" : "the apps"} to load Make0 Brain.`);
  const hints = planned.filter(({ client }) => configured.includes(client.id) && client.rulesHint);
  if (options.rules !== false && hints.length > 0) {
    log("\nThese apps keep rules in settings. Paste this so they search Brain first:");
    log(`  ${hints.map(({ client }) => client.rulesHint).join("\n  ")}`);
    log(`\n  "${MAKE0_SYSTEM_INSTRUCTION}"`);
  }
  return { configured };
}
