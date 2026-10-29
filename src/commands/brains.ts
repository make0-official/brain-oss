import os from "node:os";
import { detectClients, type InitEnv } from "../init/clients";
import { PERSONAL_BRAIN_ID } from "../shared/types";
import { BrainStoreError, type BrainStore } from "../store/store";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionals(args: string[], valueFlags: string[] = []): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (valueFlags.includes(args[index])) index += 1;
    else if (!args[index].startsWith("--")) result.push(args[index]);
  }
  return result;
}

function storeError(error: unknown): never {
  if (error instanceof BrainStoreError) fail(error.message);
  throw error;
}

export function resolveBrainArg(store: BrainStore, ref: string | undefined, fallback = PERSONAL_BRAIN_ID): string {
  if (!ref) return fallback;
  const brain = store.resolveBrain(ref);
  if (!brain) fail(`Brain not found: ${ref}`);
  return brain.id;
}

function printBrain(store: BrainStore, id: string): void {
  const brain = store.getBrain(id);
  if (!brain) return;
  const live = store.countMemories({ brainId: brain.id });
  const description = brain.description ? ` — ${brain.description}` : "";
  const emoji = brain.emoji ? `${brain.emoji} ` : "";
  console.log(`${emoji}${brain.name} (${brain.id})  ${brain.kind}  ${live} live${description}`);
}

export function brainsCommand(store: BrainStore, args: string[]): void {
  const [action, ...rest] = args;
  if (!action) {
    for (const brain of store.listBrains()) printBrain(store, brain.id);
    return;
  }
  if (action === "create") {
    const name = positionals(rest, ["--description", "--emoji", "--agents"]).join(" ").trim();
    if (!name) fail("Usage: make0-brain brains create <name> [--description <text>] [--emoji <emoji>] [--agents <ids>]");
    try {
      const brain = store.createBrain({
        name,
        description: flagValue(rest, "--description"),
        emoji: flagValue(rest, "--emoji"),
      });
      const agents = flagValue(rest, "--agents")
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      for (const clientId of agents ?? []) store.grantClientBrain(clientId, brain.id);
      printBrain(store, brain.id);
    } catch (error) {
      storeError(error);
    }
    return;
  }
  if (action === "edit") {
    const ref = positionals(rest, ["--name", "--description", "--emoji"])[0];
    if (!ref) fail("Usage: make0-brain brains edit <id> [--name <name>] [--description <text>] [--emoji <emoji>]");
    const brain = store.resolveBrain(ref);
    if (!brain) fail(`Brain not found: ${ref}`);
    const updates: { name?: string; description?: string | null; emoji?: string | null } = {};
    const name = flagValue(rest, "--name");
    const description = flagValue(rest, "--description");
    const emoji = flagValue(rest, "--emoji");
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (emoji !== undefined) updates.emoji = emoji;
    if (Object.keys(updates).length === 0) fail("Pass --name, --description, or --emoji.");
    try {
      store.updateBrain(brain.id, updates);
    } catch (error) {
      storeError(error);
    }
    printBrain(store, brain.id);
    return;
  }
  if (action === "delete") {
    const ref = positionals(rest)[0];
    if (!ref) fail("Usage: make0-brain brains delete <id> --yes");
    if (!rest.includes("--yes")) fail("Deleting a brain is permanent. Re-run with --yes.");
    const brain = store.resolveBrain(ref);
    if (!brain) fail(`Brain not found: ${ref}`);
    try {
      store.deleteBrain(brain.id);
    } catch (error) {
      storeError(error);
    }
    console.log(`Deleted ${brain.name}.`);
    return;
  }
  fail(`Unknown brains command: ${action}`);
}

function env(): InitEnv {
  return { home: os.homedir(), platform: process.platform, appData: process.env.APPDATA };
}

function printAgent(store: BrainStore, clientId: string, name: string): void {
  const brains = store.brainsVisibleToClient(clientId);
  const label = brains.length > 0 ? brains.map((brain) => brain.name).join(", ") : "no brains";
  console.log(`${name} (${clientId}): ${label}`);
}

export function agentsCommand(store: BrainStore, args: string[]): void {
  const [action, ...rest] = args;
  if (!action) {
    const detected = detectClients(env());
    const seen = new Set<string>();
    for (const client of detected) {
      seen.add(client.id);
      printAgent(store, client.id, client.name);
    }
    for (const client of store.listSeenClients()) {
      if (seen.has(client.id)) continue;
      seen.add(client.id);
      printAgent(store, client.id, client.name ?? client.id);
    }
    for (const clientId of store.listConfiguredClientIds()) {
      if (seen.has(clientId)) continue;
      seen.add(clientId);
      printAgent(store, clientId, clientId);
    }
    return;
  }
  if (action !== "grant" && action !== "revoke") fail(`Unknown agents command: ${action}`);
  const [clientId, ...refs] = positionals(rest);
  if (!clientId || refs.length === 0) {
    fail(`Usage: make0-brain agents ${action} <client> <brain…>`);
  }
  for (const ref of refs) {
    const brain = store.resolveBrain(ref);
    if (!brain) fail(`Brain not found: ${ref}`);
    try {
      if (action === "grant") store.grantClientBrain(clientId, brain.id);
      else store.revokeClientBrain(clientId, brain.id);
    } catch (error) {
      storeError(error);
    }
  }
  printAgent(store, clientId, clientId);
}

export function printStats(store: BrainStore, brainId?: string): void {
  const brains = brainId ? store.listBrains().filter((brain) => brain.id === brainId) : store.listBrains();
  for (const brain of brains) {
    const live = store.countMemories({ brainId: brain.id });
    const archived = store.listArchivedMemories(brain.id).length;
    const links = store.listEdges(brain.id).length;
    console.log(`${brain.name} (${brain.id}): ${live} live, ${archived} archived, ${links} links`);
  }
}
