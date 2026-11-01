import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentLabel } from "../import/sessions";
import type { ImportFile } from "../import/sources";
import { detectClients } from "../init/clients";
import { PERSONAL_BRAIN_ID, type Memory } from "../shared/types";
import { type Choice, plural, type Steps } from "../stepper";
import type { BrainStore } from "../store/store";

/**
 * Steppers for CLI commands run without their arguments. Each one asks for
 * what is missing and returns the arguments the command would have taken,
 * so the command itself runs the same way it does from a script.
 */

function brainChoices(store: BrainStore, filter: (id: string) => boolean = () => true): Choice<string>[] {
  return store
    .listBrains()
    .filter((brain) => filter(brain.id))
    .map((brain) => ({
      label: `${brain.emoji ? `${brain.emoji} ` : ""}${brain.name}`,
      value: brain.id,
      id: brain.id,
      hint: plural(store.countMemories({ brainId: brain.id }), "memory", "memories"),
    }));
}

function preview(memory: Memory, max = 70): string {
  const line = memory.content.replace(/^#+\s*/gm, "").split("\n").find((text) => text.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Apps detected on this machine plus any that have connected before. */
function appChoices(store: BrainStore): Choice<string>[] {
  const seen = new Map<string, string>();
  for (const client of detectClients({ home: os.homedir(), platform: process.platform, appData: process.env.APPDATA })) seen.set(client.id, client.name);
  for (const client of store.listSeenClients()) if (!seen.has(client.id)) seen.set(client.id, client.name ?? client.id);
  for (const id of store.listConfiguredClientIds()) if (!seen.has(id)) seen.set(id, id);
  return [...seen].map(([id, name]) => ({ label: name, value: id, id, hint: id }));
}

/** `make0-brain` at a terminal: what to do, as the command line it stands for. */
export async function mainMenuSteps(make: Steps): Promise<string[] | null> {
  const steps = make();
  const pick = await steps.select<string[] | null>("Start", "What do you want to do?", [
    { label: "Connect your agents", value: ["init"], hint: "init" },
    { label: "Import coding-agent sessions", value: ["import", "--sessions"], hint: "import --sessions" },
    { label: "Import notes, a folder, or agent rules", value: ["import"], hint: "import" },
    { label: "Open the viewer", value: ["view"], hint: "view" },
    { label: "Create a brain", value: ["brains", "create"], hint: "brains create" },
    { label: "Give an app access to brains", value: ["agents", "grant"], hint: "agents grant" },
    { label: "Remove an app's access", value: ["agents", "revoke"], hint: "agents revoke" },
    { label: "Export memories", value: ["export"], hint: "export" },
    { label: "Restore an archived memory", value: ["restore"], hint: "restore" },
    { label: "Show stats", value: ["stats"], hint: "stats" },
    { label: "Quit", value: null },
  ]);
  return pick;
}

/** `import` with nothing to import: sessions, rule files, or a path. */
export async function importSourceSteps(make: Steps): Promise<string[] | null> {
  const steps = make();
  const kind = await steps.select("What to import", "Import what?", [
    { label: "Coding-agent sessions", value: "sessions", hint: "Claude Code, Codex, Cursor, Copilot and 37 more" },
    { label: "Agent rule files", value: "detect", hint: "CLAUDE.md, AGENTS.md, .cursor/rules, …" },
    { label: "A folder or a file", value: "path", hint: "Markdown notes or an Obsidian vault" },
    { label: "Cancel", value: "cancel" },
  ]);
  if (kind === "cancel") return null;
  if (kind === "sessions") return ["--sessions"];
  if (kind === "detect") return ["--detect"];
  const target = await steps.text(null, "Path", "", (value) =>
    !value ? "Type a path." : fs.existsSync(path.resolve(value.replace(/^~(?=\/|$)/, os.homedir()))) ? null : `Not found: ${value}`,
  );
  return [target.replace(/^~(?=\/|$)/, os.homedir())];
}

export type SessionPlan = { files: ImportFile[]; brain: { id: string } | { create: string } };

/**
 * `import --sessions`: which agents (from what was found), which brain, then
 * a confirmation. Steps whose flag was passed are skipped.
 */
export async function sessionImportSteps(
  make: Steps,
  input: { files: ImportFile[]; store: BrainStore; askAgents: boolean; brainId?: string; windowLabel: string; limit?: number },
): Promise<SessionPlan | null> {
  const total = (input.askAgents ? 1 : 0) + (input.brainId ? 0 : 1) + 1;
  const steps = make(total);
  const counts = new Map<string, number>();
  for (const file of input.files) {
    const id = file.source.replace(/-session$/, "");
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const agents = [...counts].sort((a, b) => b[1] - a[1] || agentLabel(a[0]).localeCompare(agentLabel(b[0])));
  let chosen = agents.map(([id]) => id);
  if (input.askAgents) {
    chosen = await steps.multi(
      "Agents",
      "Import from which?",
      agents.map(([id, count]) => ({ label: agentLabel(id), value: id, id, hint: plural(count, "session") })),
    );
    if (chosen.length === 0) return null;
  }
  const picked = new Set(chosen);
  let files = input.files.filter((file) => picked.has(file.source.replace(/-session$/, "")));
  if (input.limit && files.length > input.limit) files = files.slice(-input.limit);

  let brain: SessionPlan["brain"] = { id: input.brainId ?? PERSONAL_BRAIN_ID };
  let brainName = input.brainId ? (input.store.getBrain(input.brainId)?.name ?? input.brainId) : "";
  if (!input.brainId) {
    const choices: Choice<string | null>[] = [...brainChoices(input.store), { label: "Create a new brain", value: null, id: "new" }];
    const personal = choices.findIndex((choice) => choice.value === PERSONAL_BRAIN_ID);
    const id = await steps.select("Brain", "Save into which brain?", choices, Math.max(0, personal));
    if (id) {
      brain = { id };
      brainName = input.store.getBrain(id)?.name ?? id;
    } else {
      const name = await steps.text(null, "Name for the new brain", "Agent sessions", (value) =>
        input.store.listBrains().some((existing) => existing.name.toLowerCase() === value.toLowerCase()) ? `A brain named ${value} already exists.` : null,
      );
      brain = { create: name };
      brainName = `${name} (new)`;
    }
  }

  const byAgent = new Map<string, number>();
  for (const file of files) {
    const id = file.source.replace(/-session$/, "");
    byAgent.set(id, (byAgent.get(id) ?? 0) + 1);
  }
  const ok = await steps.confirm(
    "Confirm",
    [
      `${plural(files.length, "session")} from ${input.windowLabel}: ${[...byAgent]
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => `${agentLabel(id)} ${count}`)
        .join(", ")}`,
      `Into: ${brainName}, one category per project`,
      ...(input.limit && files.length === input.limit ? [`Capped at the newest ${input.limit} (--limit changes it)`] : []),
    ],
    "Import now?",
  );
  return ok ? { files, brain } : null;
}

/** `import <paths>` or `--detect` without `--brain`: which brain. */
export async function importBrainStep(make: Steps, store: BrainStore): Promise<string> {
  const choices = brainChoices(store);
  if (choices.length < 2) return PERSONAL_BRAIN_ID;
  const steps = make();
  const personal = choices.findIndex((choice) => choice.value === PERSONAL_BRAIN_ID);
  return steps.select("Brain", "Import into which brain?", choices, Math.max(0, personal));
}

/** `brains create` without a name. */
export async function brainCreateSteps(make: Steps, store: BrainStore): Promise<string[]> {
  const steps = make(3);
  const name = await steps.text("Name", "Brain name", "", (value) =>
    !value ? "Type a name." : store.listBrains().some((brain) => brain.name.toLowerCase() === value.toLowerCase()) ? `A brain named ${value} already exists.` : null,
  );
  const description = await steps.text("Description", "What is it for? (Enter to skip)");
  const apps = appChoices(store);
  const agents = apps.length ? await steps.multi("Apps", "Which apps can use it?", apps, false) : [];
  return ["create", name, ...(description ? ["--description", description] : []), ...(agents.length ? ["--agents", agents.join(",")] : [])];
}

/** `brains edit` or `brains delete` without an id. */
export async function brainPickSteps(make: Steps, store: BrainStore, action: "edit" | "delete"): Promise<string[] | null> {
  const choices = brainChoices(store, (id) => action === "edit" || id !== PERSONAL_BRAIN_ID);
  if (!choices.length) {
    make().log("Only the personal brain exists, and it cannot be deleted.");
    return null;
  }
  const steps = make(action === "edit" ? 3 : 2);
  const id = await steps.select("Brain", `${action === "edit" ? "Edit" : "Delete"} which brain?`, choices);
  const brain = store.getBrain(id)!;
  if (action === "delete") {
    const memories = store.countMemories({ brainId: id, includeArchived: true });
    const ok = await steps.confirm("Confirm", [`Delete ${brain.name} and its ${plural(memories, "memory", "memories")}. This cannot be undone.`], "Delete it?", false);
    return ok ? ["delete", id, "--yes"] : null;
  }
  const name = await steps.text("Name", "Name", brain.name);
  const description = await steps.text("Description", "Description", brain.description ?? "");
  return ["edit", id, "--name", name, "--description", description];
}

/** `agents grant` or `agents revoke` without an app or brains. */
export async function agentAccessSteps(make: Steps, store: BrainStore, action: "grant" | "revoke", clientId?: string): Promise<string[] | null> {
  const steps = make(clientId ? 1 : 2);
  const apps = appChoices(store);
  if (!clientId) {
    if (!apps.length) {
      make().log("No apps found. Run make0-brain init first.");
      return null;
    }
    clientId = await steps.select("App", action === "grant" ? "Give which app access?" : "Remove access for which app?", apps);
  }
  const visible = new Set(store.brainsVisibleToClient(clientId).map((brain) => brain.id));
  const choices = brainChoices(store, (id) => (action === "grant" ? !visible.has(id) : visible.has(id)));
  if (!choices.length) {
    make().log(action === "grant" ? "That app can already use every brain." : "That app has no brains to remove.");
    return null;
  }
  const brains = await steps.multi("Brains", action === "grant" ? "Which brains can it use?" : "Remove which brains?", choices, false);
  return brains.length ? [action, clientId, ...brains] : null;
}

/** `export` without a format or destination. */
export async function exportSteps(make: Steps, store: BrainStore): Promise<string[]> {
  const steps = make(3);
  const json = await steps.select("Format", "Export as?", [
    { label: "Markdown files", value: false, hint: "one file per memory, opens as an Obsidian vault" },
    { label: "JSON bundle", value: true, hint: "every memory, version and link (the Make0 port format)" },
  ]);
  const brains = brainChoices(store);
  const brainId =
    brains.length > 1 ? await steps.select<string | null>("Brain", "Export which brain?", [{ label: "All brains", value: null }, ...brains]) : null;
  if (brains.length <= 1) steps.log("\n(One brain, exporting it.)");
  const target = await steps.text("Destination", "Write to", json ? "make0-brain-bundle.json" : "make0-brain-export");
  return [...(json ? ["--json"] : []), target, ...(brainId ? ["--brain", brainId] : [])];
}

/** `restore` or `purge` without an id: pick an archived memory. */
export async function archivedPickSteps(make: Steps, store: BrainStore, action: "restore" | "purge"): Promise<string[] | null> {
  const archived = store
    .listArchivedMemories()
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
    .slice(0, 30);
  if (!archived.length) {
    make().log("No archived memories.");
    return null;
  }
  const names = new Map(store.listBrains().map((brain) => [brain.id, brain.name]));
  const steps = make(2);
  const id = await steps.select(
    "Memory",
    action === "restore" ? "Restore which memory?" : "Permanently delete which memory?",
    archived.map((memory) => ({ label: preview(memory), value: memory.id, id: memory.id, hint: `${names.get(memory.brainId) ?? memory.brainId} · archived ${String(memory.deletedAt).slice(0, 10)}` })),
  );
  const memory = archived.find((item) => item.id === id)!;
  const ok =
    action === "restore"
      ? await steps.confirm("Confirm", [`Restore "${preview(memory, 60)}".`], "Restore it?")
      : await steps.confirm("Confirm", [`Permanently delete "${preview(memory, 60)}" and every version of it. This cannot be undone.`], "Delete it?", false);
  if (!ok) return null;
  return action === "restore" ? [id] : [id, "--yes"];
}

/** `history` without an id: pick one of the most recently changed memories. */
export async function memoryPickSteps(make: Steps, store: BrainStore): Promise<string[] | null> {
  const recent = store
    .listMemories()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 30);
  if (!recent.length) {
    make().log("No memories yet.");
    return null;
  }
  const steps = make();
  const id = await steps.select(
    "Memory",
    "Show the versions of which memory?",
    recent.map((memory) => ({ label: preview(memory), value: memory.id, id: memory.id, hint: `${memory.category} · ${memory.updatedAt.slice(0, 10)}` })),
  );
  return [id];
}

