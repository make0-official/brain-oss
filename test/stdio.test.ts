import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, test } from "vitest";

const cli = path.resolve(__dirname, "../dist/cli.js");

// Spawns the built CLI. Run `npm run build` first; opt in with MAKE0_BRAIN_E2E=1.
// Uses real local models unless MAKE0_BRAIN_EMBEDDINGS=hashing.
describe.skipIf(process.env.MAKE0_BRAIN_E2E !== "1")("stdio server", () => {
  test("serves the tools over stdio and persists to disk", { timeout: 240_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "make0-brain-"));
    const env = {
      ...(process.env as Record<string, string>),
      MAKE0_BRAIN_DB: path.join(dir, "brain.db"),
    };

    const client = new Client({ name: "claude-code", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0].text);
    };

    await call("add_memory", { brain: "personal", content: "My dog is named Bruno" });
    await call("add_memory", { brain: "personal", content: "I work as a product designer at Acme" });
    await call("add_memory", { brain: "personal", content: "I prefer window seats on long flights" });
    const search = await call("search_brain", { brain: "personal", query: "what is my pet called?" });
    await client.close();

    assert.match(search.memories[0].content, /Bruno/);
    assert.equal(search.memories[0].addedBy, "claude");
    assert.ok(fs.existsSync(env.MAKE0_BRAIN_DB));
  });
});
