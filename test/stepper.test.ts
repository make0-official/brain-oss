import assert from "node:assert/strict";
import { test } from "vitest";
import {
  agentAccessSteps,
  archivedPickSteps,
  brainCreateSteps,
  brainPickSteps,
  exportSteps,
  importSourceSteps,
  mainMenuSteps,
  sessionImportSteps,
} from "../src/commands/steps";
import type { ImportFile } from "../src/import/sources";
import { type PromptIO, type Steps, TextStepper, textSteps } from "../src/stepper";
import { BrainStore } from "../src/store/store";

type Scripted = Steps & { lines: string[]; io: PromptIO };

/** Answers questions in order and records everything printed. */
function scripted(...answers: string[]): Scripted {
  const lines: string[] = [];
  const io: PromptIO = { log: (line) => lines.push(line), ask: async () => answers.shift() ?? "" };
  return Object.assign(textSteps(io), { lines, io });
}

function session(agent: string, n: number): ImportFile {
  return { path: `/s/${agent}/${n}`, name: `${agent} ${n}`, source: `${agent}-session`, folder: "api", text: `# Session ${n}` };
}

test("Stepper: numbered steps, defaults on Enter, retries on a bad answer", async () => {
  const io = scripted("9", "2", "", "", "1,3", "n");
  const steps = new TextStepper(io.io, 4);
  const choices = [
    { label: "One", value: 1 },
    { label: "Two", value: 2 },
    { label: "Three", value: 3 },
  ];
  assert.equal(await steps.select("Pick", "Which?", choices), 2);
  assert.equal(await steps.text("Name", "Name", "fallback"), "fallback");
  assert.deepEqual(await steps.multi("Many", "Which?", choices), [1, 2, 3]);
  assert.deepEqual(await steps.multi("Many", "Which?", choices), [1, 3]);
  assert.ok(io.lines.includes("\nStep 1 of 4 · Pick"));
  assert.ok(io.lines.includes("  Use 1-3."));
  assert.ok(io.lines.some((line) => line.startsWith("\nStep 4 of 4")));
  const noneByDefault = new TextStepper(scripted("").io);
  assert.deepEqual(await noneByDefault.multi("Apps", "Which?", choices, false), []);
});

test("main menu and import source map to the commands they stand for", async () => {
  assert.deepEqual(await mainMenuSteps(scripted("2")), ["import", "--sessions"]);
  assert.equal(await mainMenuSteps(scripted("11")), null);
  assert.deepEqual(await importSourceSteps(scripted("")), ["--sessions"]);
  assert.deepEqual(await importSourceSteps(scripted("3", "/definitely/missing", process.cwd())), [process.cwd()]);
  assert.equal(await importSourceSteps(scripted("4")), null);
});

test("import --sessions: pick agents from what was found, create a brain, confirm", async () => {
  const store = new BrainStore(":memory:");
  const files = [session("cursor", 1), session("cursor", 2), session("cursor", 3), session("codex", 1), session("claude-code", 1)];
  const io = scripted("1,3", "2", "Work sessions", "");
  const plan = await sessionImportSteps(io, { files, store, askAgents: true, windowLabel: "the last 30d" });
  // Agents are listed busiest first: Cursor 3, then Claude Code and Codex.
  assert.ok(io.lines.some((line) => /1\. Cursor\s+3 sessions/.test(line)));
  assert.deepEqual(plan!.files.map((file) => file.source), ["cursor-session", "cursor-session", "cursor-session", "codex-session"]);
  assert.deepEqual(plan!.brain, { create: "Work sessions" });
  assert.ok(io.lines.some((line) => line.includes("4 sessions from the last 30d: Cursor 3, Codex 1")));

  const declined = await sessionImportSteps(scripted("", "", "n"), { files, store, askAgents: true, windowLabel: "the last 30d" });
  assert.equal(declined, null);

  // --agent and --brain skip their steps; the limit keeps the newest of what was picked.
  const quiet = scripted("");
  const limited = await sessionImportSteps(quiet, { files, store, askAgents: false, brainId: "personal", windowLabel: "the last 30d", limit: 2 });
  assert.equal(limited!.files.length, 2);
  assert.ok(quiet.lines.includes("\nStep 1 of 1 · Confirm"));
  store.close();
});

test("brains create, edit and delete, and agents grant", async () => {
  const store = new BrainStore(":memory:");
  const created = await brainCreateSteps(scripted("Work", "Client work", ""), store);
  assert.deepEqual(created, ["create", "Work", "--description", "Client work"]);
  const work = store.createBrain({ name: "Work" });

  assert.deepEqual(await brainPickSteps(scripted("1", "y"), store, "delete"), ["delete", work.id, "--yes"]);
  assert.equal(await brainPickSteps(scripted("1", ""), store, "delete"), null, "delete defaults to no");
  assert.deepEqual(await brainPickSteps(scripted("2", "Clients", ""), store, "edit"), ["edit", work.id, "--name", "Clients", "--description", ""]);

  assert.deepEqual(await agentAccessSteps(scripted("1"), store, "grant", "cursor"), ["grant", "cursor", work.id]);
  store.close();
});

test("export and restore pick their options", async () => {
  const store = new BrainStore(":memory:");
  assert.deepEqual(await exportSteps(scripted("2", "out.json"), store), ["--json", "out.json"]);
  const work = store.createBrain({ name: "Work" });
  assert.deepEqual(await exportSteps(scripted("", "3", ""), store), ["make0-brain-export", "--brain", work.id]);

  const io = scripted();
  assert.equal(await archivedPickSteps(io, store, "restore"), null);
  assert.ok(io.lines.includes("No archived memories."));
  store.close();
});
