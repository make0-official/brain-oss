import os from "node:os";
import { clientConfigIncludesServer, detectClients, MAKE0_SYSTEM_INSTRUCTION, MCP_CLIENTS, type InitEnv } from "../init/clients";
import { PERSONAL_BRAIN_ID, type UserBrain } from "../shared/types";
import { USER_CLIENT_ID } from "../shared/usage";
import { BrainStoreError, type BrainStore } from "../store/store";
import { ViewInputError } from "./write";

export type ViewBrain = UserBrain & {
  memoryCount: number;
  agents: Array<{ id: string; name: string }>;
};

export type ViewAgent = {
  id: string;
  name: string;
  detected: boolean;
  connected: boolean;
  /** Last MCP connection from this app, when it has connected at least once. */
  lastSeenAt: string | null;
  brainIds: string[];
};

function viewerEnv(): InitEnv {
  return { home: os.homedir(), platform: process.platform, appData: process.env.APPDATA };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ViewInputError("Expected a JSON object.");
  return body as Record<string, unknown>;
}

function optionalString(value: unknown): string | null | undefined {
  if (value == null) return value as null | undefined;
  if (typeof value !== "string") throw new ViewInputError("Expected text.");
  return value;
}

function agentIds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ViewInputError("agentIds must be a list of agent ids.");
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function brainIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ViewInputError("brainIds must be a list of brain ids.");
  }
  return value;
}

function rethrowStore(error: unknown): never {
  if (error instanceof BrainStoreError) throw new ViewInputError(error.message);
  throw error;
}

export function agentName(id: string, seenName?: string | null): string {
  if (id === USER_CLIENT_ID) return "You";
  return MCP_CLIENTS.find((client) => client.id === id)?.name ?? seenName ?? id;
}

function seenNames(store: BrainStore): Map<string, string | null> {
  return new Map(store.listSeenClients().map((client) => [client.id, client.name]));
}

export function listViewBrains(store: BrainStore): ViewBrain[] {
  const env = viewerEnv();
  const seen = seenNames(store);
  const known = [
    ...detectClients(env).map((client) => client.id),
    ...seen.keys(),
    ...store.listAgentGrants().map((grant) => grant.clientId),
  ];
  return store.listBrains().map((brain) => ({
    ...brain,
    memoryCount: store.countMemories({ brainId: brain.id }),
    agents: store.clientIdsForBrain(brain.id, known).map((id) => ({ id, name: agentName(id, seen.get(id)) })),
  }));
}

export function createViewBrain(store: BrainStore, body: unknown): ViewBrain {
  const record = asRecord(body);
  if (typeof record.name !== "string") throw new ViewInputError("Brain name is required.");
  let brain: UserBrain;
  try {
    brain = store.createBrain({
      name: record.name,
      emoji: optionalString(record.emoji),
      description: optionalString(record.description),
    });
    for (const clientId of agentIds(record.agentIds)) store.grantClientBrain(clientId, brain.id);
  } catch (error) {
    rethrowStore(error);
  }
  return listViewBrains(store).find((item) => item.id === brain.id) ?? { ...brain, memoryCount: 0, agents: [] };
}

export function updateViewBrain(store: BrainStore, id: string, body: unknown): ViewBrain {
  const record = asRecord(body);
  const existing = store.getBrain(id);
  if (!existing) throw new ViewInputError("Brain not found.");
  try {
    if (existing.kind === "personal") {
      if (record.name !== undefined || record.emoji !== undefined) {
        throw new ViewInputError("The personal brain name cannot be changed.");
      }
      store.updateBrain(id, { description: optionalString(record.description) });
    } else {
      store.updateBrain(id, {
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(record.emoji !== undefined ? { emoji: optionalString(record.emoji) } : {}),
        ...(record.description !== undefined ? { description: optionalString(record.description) } : {}),
      });
    }
  } catch (error) {
    rethrowStore(error);
  }
  return listViewBrains(store).find((item) => item.id === id) ?? { ...store.getBrain(id)!, memoryCount: 0, agents: [] };
}

export function deleteViewBrain(store: BrainStore, id: string): void {
  try {
    store.deleteBrain(id);
  } catch (error) {
    rethrowStore(error);
  }
}

export function listViewAgents(store: BrainStore): { instruction: string; agents: ViewAgent[] } {
  const env = viewerEnv();
  const detected = detectClients(env);
  const detectedIds = new Set(detected.map((client) => client.id));
  const seen = store.listSeenClients();
  const seenById = new Map(seen.map((client) => [client.id, client]));
  const extras = [
    ...new Set([...seen.map((client) => client.id), ...store.listConfiguredClientIds()]),
  ].filter((id) => !detectedIds.has(id));
  const agents: ViewAgent[] = [
    ...detected.map((client) => ({
      id: client.id,
      name: client.name,
      detected: true,
      connected: clientConfigIncludesServer(client, env),
      lastSeenAt: seenById.get(client.id)?.lastSeenAt ?? null,
      brainIds: store.brainsVisibleToClient(client.id).map((brain) => brain.id),
    })),
    ...extras.map((id) => ({
      id,
      name: agentName(id, seenById.get(id)?.name),
      detected: false,
      connected: seenById.has(id),
      lastSeenAt: seenById.get(id)?.lastSeenAt ?? null,
      brainIds: store.brainsVisibleToClient(id).map((brain) => brain.id),
    })),
  ];
  return { instruction: MAKE0_SYSTEM_INSTRUCTION, agents };
}

export function setViewAgentBrains(store: BrainStore, clientId: string, body: unknown): ViewAgent {
  const id = decodeURIComponent(clientId).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new ViewInputError("Agent id is invalid.");
  const record = asRecord(body);
  try {
    store.setClientBrains(id, brainIds(record.brainIds));
  } catch (error) {
    rethrowStore(error);
  }
  const listed = listViewAgents(store).agents.find((agent) => agent.id === id);
  return (
    listed ?? {
      id,
      name: agentName(id),
      detected: false,
      connected: false,
      lastSeenAt: null,
      brainIds: store.brainsVisibleToClient(id).map((brain) => brain.id),
    }
  );
}

export function requestedBrainId(value: string | null): string {
  return value?.trim() || PERSONAL_BRAIN_ID;
}
