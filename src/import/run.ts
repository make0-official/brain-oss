import { createHash } from "node:crypto";
import type { Brain } from "../brain";
import type { ExtractedMemory } from "../llm/extract";
import type { Memory, MemoryEntityType, MemoryKind } from "../shared/types";
import { extractWikilinks, parseFrontmatter, splitMarkdown } from "./markdown";
import { type ImportFile, isAgentSource } from "./sources";

const EMBED_BATCH_SIZE = 32;
/** Ask before adding more than this many memories in one run. */
export const IMPORT_CONFIRM_THRESHOLD = 200;
const WIKILINK_WEIGHT = 0.8;
const SECTION_LINK_WEIGHT = 0.85;

export type ImportOptions = {
  /** LLM fact extraction (BYO key) instead of section dump. */
  extract?: boolean;
  dryRun?: boolean;
  /** Called with the plan when it adds more than IMPORT_CONFIRM_THRESHOLD; false aborts. */
  confirm?: (summary: string) => Promise<boolean>;
  log?: (line: string) => void;
};

export type ImportSummary = {
  files: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Previously imported, then deleted by the user; left alone. */
  skippedArchived: number;
  /** Facts archived because their file changed (extract mode). */
  replaced: number;
  links: number;
  aborted?: boolean;
};

type PlannedItem = {
  file: ImportFile;
  key: string;
  content: string;
  category: string;
  kind: MemoryKind;
  entityType: MemoryEntityType;
  confidence: number;
  hash: string;
  fileHash: string;
  existing?: Memory;
};

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function titleCase(value: string): string {
  return value
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Category from frontmatter tags, then folder; kind/type by source. */
function dumpAttributes(file: ImportFile, tags: string[]) {
  if (isAgentSource(file.source)) {
    return { category: "Agent Instructions", kind: "profile" as const, entityType: "workflow" as const };
  }
  const category = tags[0] ? titleCase(tags[0]) : file.folder ? titleCase(file.folder.split("/").pop()!) : "Notes";
  return { category: category.slice(0, 80), kind: "work" as const, entityType: "topic" as const };
}

function planDump(file: ImportFile, existingByKey: Map<string, Memory>): PlannedItem[] {
  const fileHash = hashText(file.text);
  const { frontmatter, body } = parseFrontmatter(file.text);
  const attributes = dumpAttributes(file, frontmatter.tags);
  return splitMarkdown(body, frontmatter.title ?? file.name).map((section) => ({
    file,
    key: section.key,
    content: section.content,
    ...attributes,
    confidence: 85,
    hash: hashText(section.content),
    fileHash,
    existing: existingByKey.get(section.key),
  }));
}

function planExtracted(file: ImportFile, facts: ExtractedMemory[]): PlannedItem[] {
  const fileHash = hashText(file.text);
  return facts.map((fact, index) => ({
    file,
    key: `fact:${index + 1}`,
    ...fact,
    hash: hashText(fact.content),
    fileHash,
  }));
}

/**
 * Import files into the brain. Re-running is idempotent: an unchanged
 * section is skipped, a changed one becomes a new version, and one the user
 * deleted stays deleted.
 */
export async function runImport(brain: Brain, files: ImportFile[], options: ImportOptions = {}): Promise<ImportSummary> {
  const log = options.log ?? (() => {});
  const summary: ImportSummary = {
    files: files.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    skippedArchived: 0,
    replaced: 0,
    links: 0,
  };
  if (options.extract && !brain.llm.extract) {
    throw new Error(
      "--extract needs an API key in .env or ~/.make0/.env (OPENAI_API_KEY, OPENROUTER_API_KEY, or MAKE0_BRAIN_API_KEY).",
    );
  }

  const toAdd: PlannedItem[] = [];
  const toUpdate: PlannedItem[] = [];
  const toReplace: Memory[] = [];
  for (const file of files) {
    const previous = brain.store.listImportedMemories(file.path);
    const existingByKey = new Map(previous.map((memory) => [memory.metadata.import!.key, memory]));

    if (options.extract) {
      const fileHash = hashText(file.text);
      const facts = previous.filter((memory) => memory.metadata.import!.key.startsWith("fact:"));
      if (facts.length > 0 && facts.every((memory) => memory.metadata.import!.fileHash === fileHash)) {
        summary.unchanged += facts.length;
        continue;
      }
      log(`Extracting facts from ${file.name}…`);
      toReplace.push(...facts.filter((memory) => !memory.deletedAt));
      toAdd.push(...planExtracted(file, await brain.llm.extract!(file.name, file.text)));
      continue;
    }

    for (const item of planDump(file, existingByKey)) {
      if (!item.existing) toAdd.push(item);
      else if (item.existing.deletedAt) summary.skippedArchived += 1;
      else if (item.existing.metadata.import!.hash === item.hash) summary.unchanged += 1;
      else toUpdate.push(item);
    }
  }

  log(
    `${files.length} file(s): ${toAdd.length} new, ${toUpdate.length} changed, ${summary.unchanged} unchanged` +
      (toReplace.length ? `, ${toReplace.length} old facts replaced` : "") +
      (summary.skippedArchived ? `, ${summary.skippedArchived} you deleted (skipped)` : ""),
  );
  if (options.dryRun) return summary;
  if (toAdd.length > IMPORT_CONFIRM_THRESHOLD && options.confirm) {
    if (!(await options.confirm(`Add ${toAdd.length} memories?`))) return { ...summary, aborted: true };
  }

  for (const memory of toReplace) brain.store.archiveMemory(memory.id, "make0");
  summary.replaced = toReplace.length;

  const memoryIdsByFile = new Map<string, string[]>();
  const remember = (item: PlannedItem, id: string) => {
    const ids = memoryIdsByFile.get(item.file.path) ?? [];
    ids.push(id);
    memoryIdsByFile.set(item.file.path, ids);
  };
  const metadataFor = (item: PlannedItem) => ({
    ...(item.existing?.metadata ?? {}),
    import: { path: item.file.path, hash: item.hash, source: item.file.source, key: item.key, fileHash: item.fileHash },
  });

  for (let start = 0; start < toAdd.length; start += EMBED_BATCH_SIZE) {
    const batch = toAdd.slice(start, start + EMBED_BATCH_SIZE);
    const embeddings = await brain.embedMany(batch);
    for (const [index, item] of batch.entries()) {
      const { memory } = await brain.addMemory(
        {
          content: item.content,
          category: item.category,
          kind: item.kind,
          entityType: item.entityType,
          confidence: item.confidence,
          writer: "make0",
          isManuallyAdded: false,
          metadata: metadataFor(item),
        },
        // Notes are documents, not claims: never archive others. Facts get the heuristic only.
        { embedding: embeddings[index], link: false, supersede: options.extract ? "heuristic" : "none" },
      );
      remember(item, memory.id);
      summary.added += 1;
    }
    log(`  ${Math.min(start + EMBED_BATCH_SIZE, toAdd.length)}/${toAdd.length} added`);
  }

  for (const item of toUpdate) {
    const id = item.existing!.id;
    await brain.updateMemory(id, { content: item.content, category: item.category }, "make0");
    brain.store.updateMemory(id, { metadata: metadataFor(item) }, { recordVersion: false });
    remember(item, id);
    summary.updated += 1;
  }

  summary.links = linkImportedNotes(brain, files, memoryIdsByFile) + brain.relink();
  log(`Done: ${summary.added} added, ${summary.updated} updated, ${summary.links} links.`);
  return summary;
}

/** Sections of one note → part_of edges; Obsidian [[wikilinks]] → references edges. */
function linkImportedNotes(brain: Brain, files: ImportFile[], touched: Map<string, string[]>): number {
  if (touched.size === 0) return 0;
  const firstIdByFile = new Map<string, string>();
  const idsByFile = new Map<string, string[]>();
  for (const file of files) {
    const ids = brain.store
      .listImportedMemories(file.path)
      .filter((memory) => !memory.deletedAt)
      .map((memory) => memory.id);
    if (ids.length === 0) continue;
    idsByFile.set(file.path, ids);
    firstIdByFile.set(file.path, ids[0]);
  }
  const byName = new Map(files.map((file) => [file.name.toLowerCase(), file.path]));

  let created = 0;
  for (const file of files) {
    if (!touched.has(file.path)) continue;
    const ids = idsByFile.get(file.path) ?? [];
    for (const id of ids.slice(1)) {
      brain.store.upsertEdge({ fromMemoryId: ids[0], toMemoryId: id, relationshipType: "part_of", weight: SECTION_LINK_WEIGHT });
      created += 1;
    }
    if (file.source !== "obsidian" && file.source !== "markdown") continue;
    for (const target of extractWikilinks(file.text)) {
      const targetPath = byName.get(target);
      const targetId = targetPath ? firstIdByFile.get(targetPath) : undefined;
      if (!targetId || !ids[0] || targetId === ids[0]) continue;
      brain.store.upsertEdge({
        fromMemoryId: ids[0],
        toMemoryId: targetId,
        relationshipType: "references",
        weight: WIKILINK_WEIGHT,
      });
      created += 1;
    }
  }
  return created;
}

/** Pasted text becomes a virtual file keyed by its hash. */
export function stdinImportFile(text: string): ImportFile {
  return { path: `stdin:${hashText(text)}`, name: "Pasted text", source: "stdin", folder: null, text };
}
