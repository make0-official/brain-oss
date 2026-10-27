const LLM_TIMEOUT_MS = 20_000;

export type LlmConfig = {
  apiKey: string;
  /** OpenAI-compatible base, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1. */
  baseUrl: string;
  /** Chat model for the pair judge, classifier, search filter, and import extraction. */
  model: string;
  /** Embedding model when `MAKE0_BRAIN_EMBEDDINGS=api`. */
  embeddingModel: string;
};

type Env = Record<string, string | undefined>;

/**
 * Read a BYO key from the environment. Returns null without a key, and the
 * brain runs fully local.
 *
 * MAKE0_BRAIN_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY
 * MAKE0_BRAIN_BASE_URL, MAKE0_BRAIN_LLM_MODEL, MAKE0_BRAIN_EMBEDDING_MODEL
 */
export function resolveLlmConfig(env: Env = process.env): LlmConfig | null {
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  const apiKey = env.MAKE0_BRAIN_API_KEY?.trim() || openRouterKey || env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const openRouter =
    env.MAKE0_BRAIN_BASE_URL?.includes("openrouter.ai") ||
    (!env.MAKE0_BRAIN_BASE_URL && (apiKey === openRouterKey || apiKey.startsWith("sk-or-")));
  const baseUrl = (
    env.MAKE0_BRAIN_BASE_URL?.trim() || (openRouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")
  ).replace(/\/+$/, "");
  return {
    apiKey,
    baseUrl,
    model: env.MAKE0_BRAIN_LLM_MODEL?.trim() || (openRouter ? "openai/gpt-6-luna" : "gpt-6-luna"),
    embeddingModel:
      env.MAKE0_BRAIN_EMBEDDING_MODEL?.trim() ||
      (openRouter ? "openai/text-embedding-3-small" : "text-embedding-3-small"),
  };
}

type ChatMessage = { content?: unknown; reasoning?: unknown };

function messageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((part) =>
              part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "",
            )
            .join("")
        : "";
  if (content.trim()) return content;
  return typeof message.reasoning === "string" ? message.reasoning : "";
}

/** Tolerates code fences and prose around one JSON object. */
export function parseJsonObjectLoose(raw: string): unknown | null {
  const candidate = raw.trim();
  if (!candidate) return null;
  const unfenced = candidate
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const tryParse = (value: string) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  };
  const direct = tryParse(unfenced);
  if (direct && typeof direct === "object") return direct;
  const jsonMatch = unfenced.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  const nested = tryParse(jsonMatch[0]);
  return nested && typeof nested === "object" ? nested : null;
}

/** GPT-6 family, with or without a provider prefix (`openai/gpt-6-luna`). */
function isGpt6Model(model: string): boolean {
  return /(^|\/)gpt-6/.test(model);
}

/**
 * GPT-6 models reason by default and take no `temperature` unless reasoning is
 * off. These are short JSON tasks, so turn reasoning off and cap the completion.
 * Other models keep the classic `max_tokens` + `temperature: 0`.
 */
export function samplingParams(model: string, maxTokens: number): Record<string, unknown> {
  if (isGpt6Model(model)) return { max_completion_tokens: maxTokens, reasoning_effort: "none" };
  return { max_tokens: maxTokens, temperature: 0 };
}

/** Minimal OpenAI-compatible client. `fetch` is injectable for tests. */
export class LlmClient {
  constructor(
    readonly config: LlmConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://make0.ai",
        "X-Title": "Make0 Brain OSS",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `LLM API ${response.status}`);
    return payload;
  }

  /** One JSON-mode chat completion; returns the raw text. */
  async completeJson(params: {
    system: string;
    user: string;
    maxTokens: number;
    timeoutMs?: number;
  }): Promise<string> {
    const payload = (await this.post(
      "/chat/completions",
      {
        model: this.config.model,
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.user },
        ],
        ...samplingParams(this.config.model, params.maxTokens),
        stream: false,
        response_format: { type: "json_object" },
      },
      params.timeoutMs ?? LLM_TIMEOUT_MS,
    )) as { choices?: Array<{ message?: ChatMessage }> };
    return messageText(payload.choices?.[0]?.message);
  }

  async embed(texts: string[], dimensions: number): Promise<number[][]> {
    const payload = (await this.post(
      "/embeddings",
      { model: this.config.embeddingModel, input: texts, dimensions },
      LLM_TIMEOUT_MS,
    )) as { data?: Array<{ index: number; embedding: number[] }> };
    const rows = [...(payload.data ?? [])].sort((a, b) => a.index - b.index);
    return rows.map((row) => row.embedding);
  }
}
