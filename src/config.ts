import os from "node:os";
import path from "node:path";
import { Brain } from "./brain";
import { HashingEmbeddingProvider, LexicalPairScorer } from "./embeddings/hashing";
import { ApiEmbeddingProvider } from "./embeddings/api";
import { LocalCrossEncoder, LocalEmbeddingProvider, type WarmableModel } from "./embeddings/local";
import type { EmbeddingProvider } from "./embeddings/provider";
import { LlmClient, resolveLlmConfig } from "./llm/client";
import { createLlmFeatures } from "./llm/features";
import { BrainStore } from "./store/store";

/** `MAKE0_BRAIN_HOME` overrides ~/.make0 (db, models). */
export function brainHome(): string {
  return process.env.MAKE0_BRAIN_HOME ?? path.join(os.homedir(), ".make0");
}

export function defaultDbPath(): string {
  return process.env.MAKE0_BRAIN_DB ?? path.join(brainHome(), "brain.db");
}

/**
 * Open the local brain.
 *
 * MAKE0_BRAIN_EMBEDDINGS: `local` (default, MiniLM), `api` (BYO key,
 * text-embedding-3-small at 384 dims), or `hashing` (no download; CI only).
 * A BYO key (see `resolveLlmConfig`) turns on the pair judge, classifier,
 * import extraction, and LLM search filter; MAKE0_BRAIN_LLM_SEARCH=0 keeps
 * search on the local cross-encoder.
 */
export function openBrain(options: { dbPath?: string; env?: Record<string, string | undefined> } = {}): Brain {
  const env = options.env ?? process.env;
  const store = new BrainStore(options.dbPath ?? defaultDbPath());
  const modelDir = path.join(brainHome(), "models");
  const llmConfig = resolveLlmConfig(env);
  const client = llmConfig ? new LlmClient(llmConfig) : null;
  const llm = client ? createLlmFeatures(client, { search: env.MAKE0_BRAIN_LLM_SEARCH !== "0" }) : {};

  const embeddings = createEmbeddingProvider(env, modelDir);
  if (env.MAKE0_BRAIN_EMBEDDINGS === "hashing") {
    return new Brain({ store, embeddings, pairScorer: new LexicalPairScorer(), llm });
  }
  return new Brain({ store, embeddings, pairScorer: new LocalCrossEncoder(modelDir), llm });
}

/** Embedder for this process. The local model loads on the first embed, not at startup. */
export function createEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
  modelDir = path.join(brainHome(), "models"),
): EmbeddingProvider {
  if (env.MAKE0_BRAIN_EMBEDDINGS === "hashing") return new HashingEmbeddingProvider();
  if (env.MAKE0_BRAIN_EMBEDDINGS === "api") {
    const llmConfig = resolveLlmConfig(env);
    if (!llmConfig) {
      throw new Error(
        "MAKE0_BRAIN_EMBEDDINGS=api needs an API key in .env or ~/.make0/.env (MAKE0_BRAIN_API_KEY or OPENAI_API_KEY).",
      );
    }
    return new ApiEmbeddingProvider(new LlmClient(llmConfig));
  }
  return new LocalEmbeddingProvider(modelDir);
}

/**
 * Local models this config will run, for `init` to download before any app
 * starts the server: none with `hashing`, only the reranker with `api` embeddings.
 */
export function localModelsFor(
  env: Record<string, string | undefined> = process.env,
  modelDir = path.join(brainHome(), "models"),
): WarmableModel[] {
  if (env.MAKE0_BRAIN_EMBEDDINGS === "hashing") return [];
  const models: WarmableModel[] = [];
  if (env.MAKE0_BRAIN_EMBEDDINGS !== "api") models.push(new LocalEmbeddingProvider(modelDir));
  models.push(new LocalCrossEncoder(modelDir));
  return models;
}
