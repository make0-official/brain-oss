import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { loadEnvFiles, parseEnvFile } from "../src/env";

test("parseEnvFile reads keys, quotes, and export prefixes", () => {
  const parsed = parseEnvFile(`
# comment
OPENAI_API_KEY=sk-abc
export MAKE0_BRAIN_LLM_MODEL="gpt-x"
MAKE0_BRAIN_BASE_URL='http://localhost:11434/v1/'
EMPTY=
MAKE0_BRAIN_LLM_SEARCH=0
  `);
  assert.deepEqual(parsed, {
    OPENAI_API_KEY: "sk-abc",
    MAKE0_BRAIN_LLM_MODEL: "gpt-x",
    MAKE0_BRAIN_BASE_URL: "http://localhost:11434/v1/",
    MAKE0_BRAIN_LLM_SEARCH: "0",
  });
});

test("loadEnvFiles prefers the process env, then ./.env, then the data folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "make0-env-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  const custom = path.join(root, "custom");
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, ".make0"), { recursive: true });
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(cwd, ".env"), "MAKE0_BRAIN_HOME=" + custom + "\nOPENAI_API_KEY=from-cwd\n");
  fs.writeFileSync(
    path.join(custom, ".env"),
    "OPENAI_API_KEY=from-data\nMAKE0_BRAIN_LLM_MODEL=from-data\n",
  );
  fs.writeFileSync(path.join(home, ".make0", ".env"), "MAKE0_BRAIN_LLM_MODEL=from-default-home\n");

  const env: Record<string, string | undefined> = { MAKE0_BRAIN_LLM_SEARCH: "0" };
  loadEnvFiles({ env, cwd, homeDir: home });

  assert.equal(env.MAKE0_BRAIN_LLM_SEARCH, "0");
  assert.equal(env.OPENAI_API_KEY, "from-cwd");
  assert.equal(env.MAKE0_BRAIN_LLM_MODEL, "from-data");
  assert.equal(env.MAKE0_BRAIN_HOME, custom);
});
