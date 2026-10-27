import os from "node:os";
import path from "node:path";
import { MEMORY_EMBEDDING_DIMENSIONS } from "../shared/limits";
import type { EmbeddingProvider, PairScorer } from "./provider";

export const LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
/** Same cross-encoder the cloud uses for its MiniLM fallback. */
export const LOCAL_CROSS_ENCODER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

const CROSS_ENCODER_MAX_CHARS = 480;

type Transformers = typeof import("@huggingface/transformers");

let transformersPromise: Promise<Transformers> | null = null;

export function defaultModelCacheDir(): string {
  return path.join(process.env.MAKE0_BRAIN_HOME ?? path.join(os.homedir(), ".make0"), "models");
}

async function loadTransformers(cacheDir: string): Promise<Transformers> {
  if (!transformersPromise) {
    transformersPromise = import("@huggingface/transformers").then((module) => {
      module.env.cacheDir = cacheDir;
      module.env.logLevel = module.LogLevel.ERROR;
      return module;
    });
  }
  return transformersPromise;
}

/** Bytes downloaded so far for one model, summed over its files. */
export type ModelProgress = {
  model: string;
  loaded: number;
  total: number;
  /** False when every file came from the local cache. */
  downloading: boolean;
};

export type ModelProgressCallback = (progress: ModelProgress) => void;

/** A local model that can be downloaded and checked before first use. */
export interface WarmableModel {
  readonly model: string;
  warmUp(onProgress?: ModelProgressCallback): Promise<void>;
}

type ProgressEvent = { status: string; file?: string; loaded?: number; total?: number };

/** Turn transformers.js per-file events into one running total per model. */
function trackProgress(model: string, onProgress?: ModelProgressCallback): (event: ProgressEvent) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  let downloading = false;
  return (event) => {
    if (event.status === "download") downloading = true;
    if (event.status !== "progress" || !event.file || !event.total) return;
    files.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    onProgress?.({ model, loaded, total, downloading });
  };
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

/** Downloads once to ~/.make0/models; runs on CPU, no key. */
export class LocalEmbeddingProvider implements EmbeddingProvider, WarmableModel {
  readonly model = LOCAL_EMBEDDING_MODEL;
  readonly dimensions = MEMORY_EMBEDDING_DIMENSIONS;
  private extractor: Promise<(texts: string[], options: object) => Promise<{ tolist(): number[][] }>> | null =
    null;

  constructor(private cacheDir = defaultModelCacheDir()) {}

  private load(onProgress?: ModelProgressCallback) {
    if (!this.extractor) {
      this.extractor = loadTransformers(this.cacheDir).then(
        (transformers) =>
          transformers.pipeline("feature-extraction", this.model, {
            dtype: "q8",
            progress_callback: trackProgress(this.model, onProgress),
          }) as unknown as Promise<(texts: string[], options: object) => Promise<{ tolist(): number[][] }>>,
      );
      // A failed download must not poison later attempts in the same process.
      this.extractor.catch(() => {
        this.extractor = null;
      });
    }
    return this.extractor;
  }

  /** Download (with progress) and run one embedding, so the first real one is instant. */
  async warmUp(onProgress?: ModelProgressCallback): Promise<void> {
    await this.load(onProgress);
    await this.embed(["warm up"]);
  }

  async embed(texts: string[]): Promise<Array<number[] | null>> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }
}

type CrossEncoder = {
  tokenizer: (
    texts: string[],
    options: { text_pair: string[]; padding: boolean; truncation: boolean },
  ) => Record<string, unknown>;
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>;
};

/** ms-marco cross-encoder: one logit per pair, sigmoid to 0..1. */
export class LocalCrossEncoder implements PairScorer, WarmableModel {
  readonly model = LOCAL_CROSS_ENCODER_MODEL;
  private loaded: Promise<CrossEncoder> | null = null;

  constructor(private cacheDir = defaultModelCacheDir()) {}

  private load(onProgress?: ModelProgressCallback): Promise<CrossEncoder> {
    if (!this.loaded) {
      const progress_callback = trackProgress(this.model, onProgress);
      this.loaded = loadTransformers(this.cacheDir).then(async (transformers) => {
        const [tokenizer, model] = await Promise.all([
          transformers.AutoTokenizer.from_pretrained(this.model, { progress_callback }),
          transformers.AutoModelForSequenceClassification.from_pretrained(this.model, {
            dtype: "q8",
            progress_callback,
          }),
        ]);
        return {
          tokenizer: tokenizer as unknown as CrossEncoder["tokenizer"],
          model: model as unknown as CrossEncoder["model"],
        };
      });
      this.loaded.catch(() => {
        this.loaded = null;
      });
    }
    return this.loaded;
  }

  /** Download (with progress) and score one pair, so the first real search is instant. */
  async warmUp(onProgress?: ModelProgressCallback): Promise<void> {
    await this.load(onProgress);
    await this.score("warm up", ["warm up"]);
  }

  async score(a: string, pairs: string[]): Promise<number[]> {
    if (pairs.length === 0) return [];
    const { tokenizer, model } = await this.load();
    const query = truncate(a, CROSS_ENCODER_MAX_CHARS);
    const inputs = tokenizer(
      pairs.map(() => query),
      {
        text_pair: pairs.map((text) => truncate(text, CROSS_ENCODER_MAX_CHARS)),
        padding: true,
        truncation: true,
      },
    );
    const { logits } = await model(inputs);
    return Array.from(logits.data, (logit) => 1 / (1 + Math.exp(-logit)));
  }
}
