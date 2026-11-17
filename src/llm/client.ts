const LLM_TIMEOUT_MS = 20_000;
/** Local models load on the first call and run slower than a hosted API. */
const LOCAL_TIMEOUT_SCALE = 5;
const LOCAL_DEFAULT_MODEL = "llama3.2";

/**
 * Where the endpoint runs: on this machine (loopback), on the user's own
 * network (a private address), or somewhere else (a hosted API).
 */
export type EndpointLocation = "machine" | "network" | "remote";

export type LlmConfig = {
  /** Empty for a keyless server (Ollama, LM Studio, llama.cpp). */
  apiKey: string;
  /** OpenAI-compatible base, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1. */
  baseUrl: string;
  /** Chat model for the pair judge, classifier, search filter, and import extraction. */
  model: string;
  /** Embedding model when `MAKE0_BRAIN_EMBEDDINGS=api`. */
  embeddingModel: string;
  /** A model server the user runs (this machine or their network): longer timeouts, search stays local. */
  local: boolean;
  location: EndpointLocation;
};

type Env = Record<string, string | undefined>;

function hostnameOf(baseUrl: string | undefined): string | null {
  if (!baseUrl?.trim()) return null;
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** localhost, 127.x, [::1], or a `.localhost` name. */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  const host = hostnameOf(baseUrl);
  if (!host) return false;
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

const PRIVATE_NAME_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal"];

/**
 * A private address on the user's own network: 10/8, 172.16/12, 192.168/16,
 * 100.64/10 (carrier-grade NAT, Tailscale), 169.254/16, fc00::/7, fe80::/10,
 * or a `.local`, `.lan`, `.home.arpa`, or `.internal` name.
 */
export function isPrivateNetworkBaseUrl(baseUrl: string | undefined): boolean {
  const host = hostnameOf(baseUrl);
  if (!host) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    );
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    const v6 = host.slice(1, -1);
    return /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
  }
  return PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/**
 * Where a base URL runs. MAKE0_BRAIN_LLM_LOCAL=1 marks any URL as a server the
 * user runs (a hostname the address check cannot place, a tunnel); =0 treats
 * even a private one as hosted.
 */
export function endpointLocation(baseUrl: string | undefined, env: Env = process.env): EndpointLocation {
  const override = env.MAKE0_BRAIN_LLM_LOCAL?.trim();
  const machine = isLocalBaseUrl(baseUrl);
  if (override === "0") return "remote";
  if (machine) return "machine";
  if (override === "1" || isPrivateNetworkBaseUrl(baseUrl)) return "network";
  return "remote";
}

/**
 * Read a BYO key or a model server from the environment. Returns null with
 * neither a key nor a base URL, and the brain runs with its local models only.
 *
 * MAKE0_BRAIN_API_KEY | OPENROUTER_API_KEY | OPENAI_API_KEY
 * MAKE0_BRAIN_LLM_BASE_URL, MAKE0_BRAIN_LLM_MODEL, MAKE0_BRAIN_EMBEDDING_MODEL
 * MAKE0_BRAIN_LLM_LOCAL=1|0 overrides whether the base URL is a server the user runs.
 *
 * A base URL needs no key. One on this machine or a private network gets only
 * MAKE0_BRAIN_API_KEY, never a hosted provider's key.
 * MAKE0_BRAIN_BASE_URL, its name before 0.3, still works.
 */
export function resolveLlmConfig(env: Env = process.env): LlmConfig | null {
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  const baseUrlSetting = env.MAKE0_BRAIN_LLM_BASE_URL?.trim() || env.MAKE0_BRAIN_BASE_URL?.trim() || undefined;
  const location = endpointLocation(baseUrlSetting, env);
  if (baseUrlSetting && location !== "remote") {
    return {
      apiKey: env.MAKE0_BRAIN_API_KEY?.trim() ?? "",
      baseUrl: baseUrlSetting.replace(/\/+$/, ""),
      model: env.MAKE0_BRAIN_LLM_MODEL?.trim() || LOCAL_DEFAULT_MODEL,
      embeddingModel: env.MAKE0_BRAIN_EMBEDDING_MODEL?.trim() || "nomic-embed-text",
      local: true,
      location,
    };
  }
  const apiKey = env.MAKE0_BRAIN_API_KEY?.trim() || openRouterKey || env.OPENAI_API_KEY?.trim() || "";
  // A keyless hosted endpoint is still sent requests, so a wrong setup fails
  // with the server's own error in the log instead of turning features off.
  if (!apiKey && !baseUrlSetting) return null;
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
    location: "remote",
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
