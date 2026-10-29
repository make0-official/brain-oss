export type Brain = {
  id: string;
  name: string;
  emoji: string | null;
  description: string | null;
  kind: "personal" | "custom";
  memoryCount: number;
  agents: Array<{ id: string; name: string }>;
};

export type Agent = {
  id: string;
  name: string;
  detected: boolean;
  connected: boolean;
  lastSeenAt: string | null;
  brainIds: string[];
};

export type Memory = {
  id: string;
  content: string;
  category: string;
  addedBy: string;
  updatedBy: string;
  writerName?: string | null;
  edited: boolean;
  updatedAt: string;
  createdAt: string;
};

export type MemoryEdge = {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relationshipType: string;
  weight: number;
};

export type MemoryList = { memories: Memory[]; archived: Memory[]; edges: MemoryEdge[] };

export type MemoryVersion = {
  versionNumber: number;
  content: string;
  writtenBy: string;
  writerName?: string | null;
  isCurrent: boolean;
  createdAt: string;
  embeddingModel?: string | null;
};

export type Embedding = {
  embedder: { name: string; model: string; dimensions: number };
  storedModel?: string | null;
  dimensions?: number;
  values?: number[];
  missing?: boolean;
  stale?: boolean;
};

export type ViewConfig = {
  embedder: { name: string; model: string; dimensions: number; detail: string };
  reranker: { name: string; model: string; detail: string };
  retrieval: string;
  llm: { enabled: boolean; model: string; detail: string };
  database: string;
  howToChange: string;
  version: string;
};

export type UsageTotals = { reads: number; writes: number; tokensIn: number; tokensOut: number };
export type UsagePoint = UsageTotals & { day: string };
export type Usage = {
  days: string[];
  total: UsagePoint[];
  month: UsageTotals;
  clients: Array<{ id: string; name: string; points: UsagePoint[]; month: UsageTotals }>;
  brains: Record<string, { points: UsagePoint[]; month: UsageTotals }>;
  series: Array<{ clientId: string; brainId: string; points: UsagePoint[] }>;
};

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload;
}

export const enc = encodeURIComponent;

export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const WRITER_LABELS: Record<string, string> = {
  user: "You",
  make0: "Make0",
  claude: "Claude",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
  mcp: "MCP",
};

export function writerLabel(writtenBy: string, writerName?: string | null): string {
  if (writtenBy === "mcp" && writerName) return writerName;
  return WRITER_LABELS[writtenBy] ?? writerName ?? writtenBy;
}
