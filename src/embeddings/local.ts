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

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

/** Downloads once to ~/.make0/models; runs on CPU, no key. */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model = LOCAL_EMBEDDING_MODEL;
  readonly dimensions = MEMORY_EMBEDDING_DIMENSIONS;
  private extractor: Promise<(texts: string[], options: object) => Promise<{ tolist(): number[][] }>> | null =
    null;

  constructor(private cacheDir = defaultModelCacheDir()) {}

  private load() {
    if (!this.extractor) {
      this.extractor = loadTransformers(this.cacheDir).then(
        (transformers) =>
          transformers.pipeline("feature-extraction", this.model, { dtype: "q8" }) as unknown as Promise<
            (texts: string[], options: object) => Promise<{ tolist(): number[][] }>
          >,
      );
    }
    return this.extractor;
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
export class LocalCrossEncoder implements PairScorer {
  readonly model = LOCAL_CROSS_ENCODER_MODEL;
  private loaded: Promise<CrossEncoder> | null = null;

  constructor(private cacheDir = defaultModelCacheDir()) {}

  private load(): Promise<CrossEncoder> {
    if (!this.loaded) {
      this.loaded = loadTransformers(this.cacheDir).then(async (transformers) => {
        const [tokenizer, model] = await Promise.all([
          transformers.AutoTokenizer.from_pretrained(this.model),
          transformers.AutoModelForSequenceClassification.from_pretrained(this.model, { dtype: "q8" }),
        ]);
        return {
          tokenizer: tokenizer as unknown as CrossEncoder["tokenizer"],
          model: model as unknown as CrossEncoder["model"],
        };
      });
    }
    return this.loaded;
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
