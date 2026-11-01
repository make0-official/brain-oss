const LLM_TIMEOUT_MS = 20_000;
/** Local models load on the first call and run slower than a hosted API. */
const LOCAL_TIMEOUT_SCALE = 5;
const LOCAL_DEFAULT_MODEL = "llama3.2";

export type LlmConfig = {
  /** Empty for a keyless local server (Ollama, LM Studio, llama.cpp). */
  apiKey: string;
  /** OpenAI-compatible base, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1. */
  baseUrl: string;
  /** Chat model for the pair judge, classifier, search filter, and import extraction. */
  model: string;
  /** Embedding model when `MAKE0_BRAIN_EMBEDDINGS=api`. */
  embeddingModel: string;
  /** The endpoint is on this machine (localhost), so nothing leaves it. */
  local: boolean;
};

type Env = Record<string, string | undefined>;

/** localhost, 127.x, [::1], or a `.localhost` name. */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Read a BYO key or a local model server from the environment. Returns null
 * without either, and the brain runs with its local models only.
 *
 * MAKE0_BRAIN_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY
 * MAKE0_BRAIN_LLM_BASE_URL, MAKE0_BRAIN_LLM_MODEL, MAKE0_BRAIN_EMBEDDING_MODEL
 *
 * A localhost MAKE0_BRAIN_LLM_BASE_URL needs no key (Ollama, LM Studio, llama.cpp).
 * MAKE0_BRAIN_BASE_URL, its name before 0.3, still works.
 */
export function resolveLlmConfig(env: Env = process.env): LlmConfig | null {
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  const baseUrlSetting = env.MAKE0_BRAIN_LLM_BASE_URL?.trim() || env.MAKE0_BRAIN_BASE_URL?.trim() || undefined;
  if (isLocalBaseUrl(baseUrlSetting)) {
    return {
      apiKey: env.MAKE0_BRAIN_API_KEY?.trim() ?? "",
      baseUrl: baseUrlSetting!.replace(/\/+$/, ""),
      model: env.MAKE0_BRAIN_LLM_MODEL?.trim() || LOCAL_DEFAULT_MODEL,
      embeddingModel: env.MAKE0_BRAIN_EMBEDDING_MODEL?.trim() || "nomic-embed-text",
      local: true,
    };
  }
  const apiKey = env.MAKE0_BRAIN_API_KEY?.trim() || openRouterKey || env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const openRouter =
    baseUrlSetting?.includes("openrouter.ai") ||
    (!baseUrlSetting && (apiKey === openRouterKey || apiKey.startsWith("sk-or-")));
  const baseUrl = (
    baseUrlSetting || (openRouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")
  ).replace(/\/+$/, "");
  return {
    apiKey,
    baseUrl,
    model: env.MAKE0_BRAIN_LLM_MODEL?.trim() || (openRouter ? "openai/gpt-6-luna" : "gpt-6-luna"),
    embeddingModel:
      env.MAKE0_BRAIN_EMBEDDING_MODEL?.trim() ||
      (openRouter ? "openai/text-embedding-3-small" : "text-embedding-3-small"),
    local: false,
  };
}

/** Hosted endpoints get the LLM search filter by default; a local model only with MAKE0_BRAIN_LLM_SEARCH=1. */
export function llmSearchEnabled(config: LlmConfig | null, env: Env = process.env): boolean {
  if (!config) return false;
  return config.local ? env.MAKE0_BRAIN_LLM_SEARCH === "1" : env.MAKE0_BRAIN_LLM_SEARCH !== "0";
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "HTTP-Referer": "https://make0.ai",
      "X-Title": "Make0 Brain OSS",
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.local ? timeoutMs * LOCAL_TIMEOUT_SCALE : timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `LLM API ${response.status}`);
    return payload;
  }

  /**
   * One JSON-mode chat completion; returns the raw text. Servers that reject
   * `response_format` (some local ones) are asked again without it; the
   * callers already parse JSON out of surrounding prose.
   */
  async completeJson(params: {
    system: string;
    user: string;
    maxTokens: number;
    timeoutMs?: number;
  }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      ...samplingParams(this.config.model, params.maxTokens),
      stream: false,
      response_format: { type: "json_object" },
    };
    const timeoutMs = params.timeoutMs ?? LLM_TIMEOUT_MS;
    let payload: { choices?: Array<{ message?: ChatMessage }> };
    try {
      payload = (await this.post("/chat/completions", body, timeoutMs)) as typeof payload;
    } catch (error) {
      if (!(error instanceof Error) || !/response_format|json_object/i.test(error.message)) throw error;
      delete body.response_format;
      payload = (await this.post("/chat/completions", body, timeoutMs)) as typeof payload;
    }
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
