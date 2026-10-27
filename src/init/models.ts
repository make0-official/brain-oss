import fs from "node:fs";
import path from "node:path";
import type { ModelProgress, WarmableModel } from "../embeddings/local";

/** Files transformers.js writes for a q8 model; all present means nothing to download. */
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", path.join("onnx", "model_quantized.onnx")];

/** transformers.js reports cache reads as downloads too, so check the disk first. */
export function isModelCached(modelDir: string, model: string): boolean {
  return MODEL_FILES.every((file) => fs.existsSync(path.join(modelDir, model, file)));
}

const MODEL_LABELS: Record<string, string> = {
  "Xenova/all-MiniLM-L6-v2": "Embedding model (MiniLM)",
  "Xenova/ms-marco-MiniLM-L-6-v2": "Reranker (ms-marco MiniLM)",
};

export type PrefetchOutput = {
  log: (line: string) => void;
  /** Rewrites the current line on a TTY; omit to print 25% steps instead. */
  write?: (text: string) => void;
};

/** Hugging Face downloads occasionally fail with a bare "fetch failed"; retry those. */
const DOWNLOAD_ATTEMPTS = 3;
/** Config and tokenizer files finish first; wait for the model file before showing a percent. */
const MIN_PROGRESS_BYTES = 1_000_000;

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Download and load each model now, so the first MCP search never waits on a
 * download (an app's tool call times out after about 60s). A failure is
 * reported, not thrown: the server still downloads on first use.
 */
export async function prefetchModels(
  models: WarmableModel[],
  modelDir: string,
  out: PrefetchOutput,
  options: { retryDelayMs?: number } = {},
): Promise<{ ready: string[]; failed: string[] }> {
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const ready: string[] = [];
  const failed: string[] = [];
  if (models.length === 0) return { ready, failed };
  const allCached = models.every((model) => isModelCached(modelDir, model.model));
  out.log(
    allCached
      ? `\nChecking local models in ${modelDir}:`
      : `\nDownloading local models to ${modelDir} (one time, about 50 MB):`,
  );

  for (const model of models) {
    const label = MODEL_LABELS[model.model] ?? model.model;
    const started = Date.now();
    const cached = isModelCached(modelDir, model.model);
    let last: ModelProgress | null = null;
    let lastStep = -1;
    let lastPercent = -1;
    const onProgress = (progress: ModelProgress) => {
      last = progress;
      if (cached || !progress.downloading || progress.total < MIN_PROGRESS_BYTES) return;
      const percent = Math.min(100, Math.floor((progress.loaded / progress.total) * 100));
      if (out.write) {
        if (percent === lastPercent) return;
        lastPercent = percent;
        out.write(`\r  ↓ ${label}  ${megabytes(progress.loaded)} / ${megabytes(progress.total)}  ${percent}%   `);
      } else if (Math.floor(percent / 25) > lastStep) {
        lastStep = Math.floor(percent / 25);
        out.log(`  ↓ ${label}  ${percent}%`);
      }
    };

    let error: unknown = null;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        await model.warmUp(onProgress);
        error = null;
        break;
      } catch (caught) {
        error = caught;
        if (attempt === DOWNLOAD_ATTEMPTS) break;
        if (out.write) out.write("\r\x1b[2K");
        const reason = caught instanceof Error ? caught.message : String(caught);
        out.log(`  … ${label}  ${reason}; retrying (${attempt + 1}/${DOWNLOAD_ATTEMPTS})`);
        lastStep = -1;
        lastPercent = -1;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }

    if (out.write) out.write("\r\x1b[2K");
    if (error) {
      const reason = error instanceof Error ? error.message : String(error);
      out.log(`  ✗ ${label}  could not download: ${reason}`);
      failed.push(model.model);
      continue;
    }
    const done = last as ModelProgress | null;
    const downloaded = !cached && Boolean(done?.downloading);
    const detail = downloaded
      ? `downloaded ${megabytes(done!.total)} in ${seconds(Date.now() - started)}`
      : "already downloaded";
    out.log(`  ✓ ${label}  ${detail}`);
    ready.push(model.model);
  }

  if (failed.length > 0) {
    out.log("  The server will try again on first use. To retry now: npx @make0-ai/brain init");
  }
  return { ready, failed };
}
