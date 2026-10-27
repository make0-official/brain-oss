/**
 * SWE-ContextBench retrieval on the local brain.
 *
 * Same protocol as Table 5 of the SWE-ContextBench paper: each related issue
 * is queried against the experience corpus. A hit matches when its instance id
 * is a gold experience task. Ranking is the local brain's rankMemoriesForQuery
 * (MiniLM embeddings, hybrid shortlist, ms-marco cross-encoder, score floor
 * 0.15, relative cutoff 0.5, pad to 10). No graph and no LLM filter.
 *
 * Data: set SWE_CONTEXTBENCH_DATA to a folder with the corpus JSON
 * ({ experience: [{ instance_id, repo, text }], related: [{ instance_id, repo,
 * text, gold: [instance_id] }] }), or pass a path to the file. The embedding
 * cache and results are written next to the input.
 *
 *   SWE_CONTEXTBENCH_DATA=~/swe-contextbench/data npx tsx scripts/swe-contextbench.ts full.json 10
 *   npx tsx scripts/swe-contextbench.ts ./data/trajectories.json 10
 *   npx tsx scripts/swe-contextbench.ts full.json 10 5   # first 5 tasks, timing probe
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { LocalCrossEncoder, LocalEmbeddingProvider } from "../src/embeddings/local.ts";
import {
  MEMORY_RETRIEVAL_CROSS_ENCODER_CANDIDATES,
  MEMORY_RETRIEVAL_MIN_RESULTS,
  MEMORY_RETRIEVAL_MIN_SCORE,
  MEMORY_RETRIEVAL_RELATIVE_RATIO,
  rankMemoriesForQuery,
} from "../src/search/rank.ts";

const INPUT_ARG = process.argv[2] ?? "full.json";
const TOP_K = Math.max(1, Number(process.argv[3] ?? 10) || 10);
const LIMIT = Math.max(0, Number(process.argv[4] ?? 0) || 0);

/** A path that exists wins; otherwise the name is looked up in SWE_CONTEXTBENCH_DATA. */
function resolveInput(arg: string): string {
  if (existsSync(arg)) return resolve(arg);
  const dataDir = process.env.SWE_CONTEXTBENCH_DATA?.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  if (!dataDir) {
    console.error(
      `Corpus not found: ${arg}. Pass a path to the corpus JSON, or set SWE_CONTEXTBENCH_DATA to the folder that holds it.`,
    );
    process.exit(1);
  }
  const candidate = join(dataDir, arg);
  if (!existsSync(candidate)) {
    console.error(`Corpus not found: ${candidate}`);
    process.exit(1);
  }
  return resolve(candidate);
}

const INPUT = resolveInput(INPUT_ARG);
const DATA = dirname(INPUT);
const INPUT_NAME = basename(INPUT);
const stem = INPUT_NAME.replace(/\.json$/, "");
const EMBED_PATH = join(DATA, `embeddings-local-${INPUT_NAME}.json`);
const RESULTS_PATH = join(
  DATA,
  LIMIT > 0
    ? `${stem}-local-top${TOP_K}-probe${LIMIT}.json`
    : `${stem}-local-top${TOP_K}-results.json`,
);

type Experience = { instance_id: string; repo: string; text: string };
type Related = { instance_id: string; repo: string; text: string; gold: string[] };
type Corpus = { experience: Experience[]; related: Related[] };
type EmbeddingCache = Record<string, number[]>;
type Hit = { id: string; score: number; tokens: number; matched: boolean };

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function loadCache(): EmbeddingCache {
  if (!existsSync(EMBED_PATH)) return {};
  return JSON.parse(readFileSync(EMBED_PATH, "utf8")) as EmbeddingCache;
}

function slotStats(rows: Hit[][], slot: number) {
  const present = rows.map((hits) => hits[slot]).filter((hit): hit is Hit => Boolean(hit));
  const matched = rows.filter((hits) => hits[slot]?.matched).length;
  const score = present.reduce((sum, hit) => sum + hit.score, 0) / (present.length || 1);
  const tokens = present.reduce((sum, hit) => sum + hit.tokens, 0) / (present.length || 1);
  return {
    scorePct: Number((score * 100).toFixed(2)),
    avgTokens: Number(tokens.toFixed(2)),
    matchedPct: Number(((matched / rows.length) * 100).toFixed(2)),
  };
}

async function embedAll(
  provider: LocalEmbeddingProvider,
  texts: string[],
): Promise<Map<string, number[] | null>> {
  const cache = loadCache();
  const unique = [...new Set(texts)];
  const missing = unique.filter((text) => !cache[hashText(text)]);
  const chunkSize = 8;
  for (let offset = 0; offset < missing.length; offset += chunkSize) {
    const chunk = missing.slice(offset, offset + chunkSize);
    const vectors = await provider.embed(chunk);
    chunk.forEach((text, index) => {
      const vector = vectors[index];
      if (vector) cache[hashText(text)] = vector;
    });
    writeFileSync(EMBED_PATH, JSON.stringify(cache));
    console.log(
      `[local] embedded ${Math.min(offset + chunk.length, missing.length)}/${missing.length}`,
    );
  }
  return new Map(unique.map((text) => [text, cache[hashText(text)] ?? null]));
}

async function main() {
  const started = Date.now();
  const corpus = JSON.parse(readFileSync(INPUT, "utf8")) as Corpus;
  const tasks = corpus.related.filter((row) => row.gold.length > 0).slice(0, LIMIT || undefined);
  const byId = new Map(corpus.experience.map((row) => [row.instance_id, row]));
  console.log(
    `[local] ${corpus.experience.length} memories, ${tasks.length} related tasks, top ${TOP_K}`,
  );

  const embeddings = new LocalEmbeddingProvider();
  const pairScorer = new LocalCrossEncoder();
  const vectors = await embedAll(embeddings, [
    ...corpus.experience.map((row) => row.text),
    ...tasks.map((row) => row.text),
  ]);
  console.log(`[local] embeddings ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const memories = corpus.experience.map((memory) => ({
    id: memory.instance_id,
    text: memory.text,
    embedding: vectors.get(memory.text) ?? null,
  }));

  const rows: Hit[][] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const gold = new Set(task.gold);
    const queryStarted = Date.now();
    const ranked = await rankMemoriesForQuery(task.text, memories, {
      queryEmbedding: vectors.get(task.text) ?? null,
      minScore: MEMORY_RETRIEVAL_MIN_SCORE,
      relativeRatio: MEMORY_RETRIEVAL_RELATIVE_RATIO,
      minResults: MEMORY_RETRIEVAL_MIN_RESULTS,
      pairScorer,
    });
    const hits = ranked.slice(0, TOP_K).map((hit) => {
      const memory = byId.get(hit.id);
      return {
        id: hit.id,
        score: hit.score,
        tokens: estimateTokens(memory?.text ?? ""),
        matched: gold.has(hit.id),
      };
    });
    rows.push(hits);
    const hit = hits.some((item) => item.matched);
    const elapsed = ((Date.now() - queryStarted) / 1000).toFixed(1);
    if ((index + 1) % 10 === 0 || index + 1 === tasks.length) {
      const soFar = (rows.filter((row) => row.some((item) => item.matched)).length / rows.length) * 100;
      console.log(
        `[local] ${index + 1}/${tasks.length} ${task.instance_id} ${hit ? "hit" : "miss"} ${elapsed}s running ${soFar.toFixed(1)}%`,
      );
    }
  }

  const slots = Object.fromEntries(
    Array.from({ length: TOP_K }, (_, index) => [`top${index + 1}`, slotStats(rows, index)]),
  );
  const overall = (rows.filter((hits) => hits.some((hit) => hit.matched)).length / rows.length) * 100;
  const rankSum = Array.from({ length: TOP_K }, (_, index) => slots[`top${index + 1}`].matchedPct).reduce(
    (sum, value) => sum + value,
    0,
  );
  const report = {
    dataset: INPUT_NAME,
    brain: "local",
    setup: `local rankMemoriesForQuery (${corpus.experience.length} memories, MiniLM embed + ms-marco cross-encoder, shortlist ${MEMORY_RETRIEVAL_CROSS_ENCODER_CANDIDATES}, minScore ${MEMORY_RETRIEVAL_MIN_SCORE}, relativeRatio ${MEMORY_RETRIEVAL_RELATIVE_RATIO}, pad ${MEMORY_RETRIEVAL_MIN_RESULTS}, no graph, no LLM), reported top ${TOP_K}`,
    tasks: rows.length,
    topK: TOP_K,
    meanReturned: Number((rows.reduce((sum, hits) => sum + hits.length, 0) / rows.length).toFixed(2)),
    ...slots,
    overallMatchedPct: Number(overall.toFixed(2)),
    exclusiveRankSumPct: Number(rankSum.toFixed(2)),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2));
  console.log(`[local] wrote ${RESULTS_PATH}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
