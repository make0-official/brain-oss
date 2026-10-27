import os from "node:os";
import path from "node:path";
import { defaultDbPath } from "../config";
import { LOCAL_CROSS_ENCODER_MODEL, LOCAL_EMBEDDING_MODEL } from "../embeddings/local";
import { resolveLlmConfig } from "../llm/client";
import { MEMORY_EMBEDDING_DIMENSIONS } from "../shared/limits";

export type ViewBrainConfig = {
  embedder: { name: string; model: string; dimensions: number; detail: string };
  reranker: { name: string; model: string; detail: string };
  retrieval: string;
  llm: { enabled: boolean; model: string | null; detail: string };
  database: string;
  howToChange: string;
};

type Env = Record<string, string | undefined>;

/** What this process will use. No API keys. */
export function describeViewConfig(env: Env = process.env): ViewBrainConfig {
  const mode = env.MAKE0_BRAIN_EMBEDDINGS === "api" ? "api" : env.MAKE0_BRAIN_EMBEDDINGS === "hashing" ? "hashing" : "local";
  const llm = resolveLlmConfig(env);
  const llmSearch = Boolean(llm) && env.MAKE0_BRAIN_LLM_SEARCH !== "0";
  const dataHome = env.MAKE0_BRAIN_HOME?.trim() || path.join(os.homedir(), ".make0");

  const embedder =
    mode === "api" && llm
      ? {
          name: "API embeddings",
          model: llm.embeddingModel,
          dimensions: MEMORY_EMBEDDING_DIMENSIONS,
          detail: "Vectors come from your API key. They stay at 384 dimensions, the same width as the local model.",
        }
      : mode === "hashing"
        ? {
            name: "Hashing embedder",
            model: "hashing-bow-384",
            dimensions: MEMORY_EMBEDDING_DIMENSIONS,
            detail: "Offline stand-in used for tests. Set MAKE0_BRAIN_EMBEDDINGS=local for real memories.",
          }
        : {
            name: "Local MiniLM",
            model: LOCAL_EMBEDDING_MODEL,
            dimensions: MEMORY_EMBEDDING_DIMENSIONS,
            detail: "Runs on this machine. The model downloads once into the data folder. No API key.",
          };

  const reranker = llmSearch
    ? {
        name: "LLM reranker",
        model: llm?.model ?? "",
        detail: `Search asks ${llm?.model} to filter and rerank. If that call fails, the local MiniLM cross-encoder (${LOCAL_CROSS_ENCODER_MODEL}) is the fallback.`,
      }
    : mode === "hashing"
      ? {
          name: "Lexical overlap",
          model: "lexical",
          detail: "Word overlap stands in for the reranker in the hashing mode.",
        }
      : {
          name: "Local MiniLM cross-encoder",
          model: LOCAL_CROSS_ENCODER_MODEL,
          detail: llm
            ? "An API key is set, and MAKE0_BRAIN_LLM_SEARCH=0 keeps reranking on this local model."
            : "Reranks the semantic and keyword shortlist on this machine. No API key.",
        };

  return {
    embedder,
    reranker,
    retrieval: "Semantic search plus BM25 keyword search, then the reranker. Related memories can be pulled in along graph links.",
    llm: llm
      ? {
          enabled: true,
          model: llm.model,
          detail: "The key is set. It can judge duplicates, classify memories, and extract on import. The key itself is not shown here.",
        }
      : {
          enabled: false,
          model: null,
          detail: "No API key. Duplicate checks and search stay on the local models.",
        },
    database: defaultDbPath(),
    howToChange: [
      "Edit .env in this project, or " + dataHome + "/.env.",
      "A variable already set in the environment wins over those files.",
      "Restart the viewer after a change. Quit Claude with Cmd+Q and reopen it so the memory server reloads too.",
      "If the embedder changes, memories whose stored model does not match are embedded again on the next search and when this page opens.",
      "MAKE0_BRAIN_EMBEDDINGS=local (default) or api.",
      "MAKE0_BRAIN_EMBEDDING_MODEL sets the API embedding model.",
      "MAKE0_BRAIN_LLM_SEARCH=0 keeps the local MiniLM reranker when a key is set.",
      "MAKE0_BRAIN_LLM_MODEL sets the chat model.",
      "Set OPENAI_API_KEY, OPENROUTER_API_KEY, or MAKE0_BRAIN_API_KEY.",
      "MAKE0_BRAIN_DB sets the database file. MAKE0_BRAIN_HOME sets the data folder.",
    ].join("\n"),
  };
}
