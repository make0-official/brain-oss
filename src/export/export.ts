import fs from "node:fs";
import path from "node:path";
import type { BrainStore } from "../store/store";
import type { Memory, MemoryEdge, MemoryVersion } from "../shared/types";
import { resolveMemoryAddedBy } from "../shared/writer";

export const BUNDLE_FORMAT = "make0-brain-bundle";
export const BUNDLE_VERSION = 1;

/**
 * The port format (see PLAN.md "Port to cloud"). No embeddings: local and
 * cloud vectors may come from different models, so the receiver re-embeds.
 */
export type BrainBundle = {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  memories: Array<Omit<Memory, "embedding" | "embeddingModel">>;
  versions: Array<Omit<MemoryVersion, "id">>;
  edges: Array<Pick<MemoryEdge, "fromMemoryId" | "toMemoryId" | "relationshipType" | "weight">>;
};

/** Every memory, archived included, so history survives a port. */
export function buildBundle(store: BrainStore, now = new Date()): BrainBundle {
  const memories = store.listMemories({ includeArchived: true });
  const ids = new Set(memories.map((memory) => memory.id));
  const edges = store.db
    .prepare("SELECT from_memory_id, to_memory_id, relationship_type, weight FROM memory_edges")
    .all() as Array<{ from_memory_id: string; to_memory_id: string; relationship_type: MemoryEdge["relationshipType"]; weight: number }>;
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    memories: memories.map(({ embedding: _embedding, embeddingModel: _model, ...memory }) => memory),
    versions: memories.flatMap((memory) =>
      store
        .getVersions(memory.id)
        .reverse()
        .map(({ id: _id, ...version }) => version),
    ),
    edges: edges
      .filter((edge) => ids.has(edge.from_memory_id) && ids.has(edge.to_memory_id))
      .map((edge) => ({
        fromMemoryId: edge.from_memory_id,
        toMemoryId: edge.to_memory_id,
        relationshipType: edge.relationship_type,
        weight: edge.weight,
      })),
  };
}

export function writeBundle(store: BrainStore, file: string): BrainBundle {
  const bundle = buildBundle(store);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

function slugify(value: string, max = 50): string {
  return (
    value
      .toLowerCase()
      .replace(/^#+\s*/, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "memory"
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function memoryMarkdown(memory: Memory, versionCount: number): string {
  const frontmatter = [
    "---",
    `id: ${memory.id}`,
    `category: ${yamlString(memory.category)}`,
    `kind: ${memory.kind}`,
    `entityType: ${memory.entityType}`,
    `confidence: ${memory.confidence}`,
    `addedBy: ${resolveMemoryAddedBy(memory)}`,
    `lastWrittenVia: ${memory.lastWrittenVia}`,
    `versions: ${versionCount}`,
    `createdAt: ${memory.createdAt}`,
    `updatedAt: ${memory.updatedAt}`,
    `tags: [${yamlString(memory.category)}]`,
    "---",
  ];
  return `${frontmatter.join("\n")}\n\n${memory.content}\n`;
}

/**
 * One Markdown file per live memory, in category folders, with frontmatter.
 * Opens as an Obsidian vault; `make0-brain import` reads it back.
 */
export function writeMarkdownExport(store: BrainStore, dir: string): { files: number } {
  const memories = store.listMemories();
  const counts = store.countVersions(memories.map((memory) => memory.id));
  fs.mkdirSync(dir, { recursive: true });
  const index: string[] = ["# Make0 Brain export", "", `${memories.length} memories, exported ${new Date().toISOString()}.`, ""];
  const used = new Set<string>();
  for (const memory of [...memories].sort((a, b) => a.category.localeCompare(b.category))) {
    const folder = slugify(memory.category, 40);
    const firstLine = memory.content.split("\n").find((line) => line.trim()) ?? "memory";
    let name = `${slugify(firstLine)}-${memory.id.slice(0, 8)}`;
    while (used.has(`${folder}/${name}`)) name = `${name}-x`;
    used.add(`${folder}/${name}`);
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, `${name}.md`), memoryMarkdown(memory, counts.get(memory.id) ?? 0));
    index.push(`- [${firstLine.replace(/^#+\s*/, "").slice(0, 80)}](${folder}/${name}.md) — ${memory.category}`);
  }
  fs.writeFileSync(path.join(dir, "README.md"), `${index.join("\n")}\n`);
  return { files: memories.length };
}
