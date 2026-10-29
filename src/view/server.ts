import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createEmbeddingProvider } from "../config";
import { reembedMismatched } from "../embeddings/reembed";
import type { EmbeddingProvider } from "../embeddings/provider";
import type { BrainStore } from "../store/store";
import {
  createViewBrain,
  deleteViewBrain,
  listViewAgents,
  listViewBrains,
  requestedBrainId,
  setViewAgentBrains,
  updateViewBrain,
} from "./brains";
import { version } from "../../package.json";
import { describeViewConfig } from "./config";
import { buildMemoryList } from "./list";
import { buildViewUsage } from "./usage";
import {
  createViewMemory,
  deleteViewMemory,
  listViewVersions,
  purgeViewMemory,
  recoverViewMemory,
  restoreViewVersion,
  updateViewMemory,
  viewMemoryEmbedding,
  ViewInputError,
} from "./write";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** `dist/web` next to the bundled CLI, or the repo build when running from `src/view`. */
function resolveWebDir(): string | null {
  const candidates = [path.join(moduleDir, "web"), path.resolve(moduleDir, "../../dist/web")];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) ?? null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const PAGE_ROUTES = new Set(["/", "/index.html", "/brain"]);

function serveWeb(pathname: string, response: ServerResponse): boolean {
  const webDir = resolveWebDir();
  if (!webDir) {
    if (!PAGE_ROUTES.has(pathname)) return false;
    response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    response.end("<p>The viewer UI is not built. Run <code>npm run build:web</code>.</p>");
    return true;
  }
  const relative = PAGE_ROUTES.has(pathname) ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(webDir, relative);
  if (!file.startsWith(webDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const html = file.endsWith(".html");
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": html ? "no-store" : relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=86400",
  });
  response.end(fs.readFileSync(file));
  return true;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64_000) throw new ViewInputError("Request is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ViewInputError("Expected JSON.");
  }
}

async function handle(
  store: BrainStore,
  embeddings: EmbeddingProvider,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const brainId = requestedBrainId(url.searchParams.get("brain"));
  const brainMatch = /^\/api\/brains\/([^/]+)$/.exec(url.pathname);
  const agentBrainsMatch = /^\/api\/agents\/([^/]+)\/brains$/.exec(url.pathname);
  const memoryMatch = /^\/api\/memories\/([^/]+)$/.exec(url.pathname);
  const versionMatch = /^\/api\/memories\/([^/]+)\/versions$/.exec(url.pathname);
  const restoreMatch = /^\/api\/memories\/([^/]+)\/versions\/(\d+)\/restore$/.exec(url.pathname);
  const recoverMatch = /^\/api\/memories\/([^/]+)\/restore$/.exec(url.pathname);
  const embeddingMatch = /^\/api\/memories\/([^/]+)\/embedding$/.exec(url.pathname);
  const purgeMatch = /^\/api\/memories\/([^/]+)\/purge$/.exec(url.pathname);

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, { ...describeViewConfig(), version });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/brains") {
    sendJson(response, 200, { brains: listViewBrains(store) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/brains") {
    sendJson(response, 201, createViewBrain(store, await readJson(request)));
    return;
  }
  if (request.method === "PATCH" && brainMatch) {
    sendJson(response, 200, updateViewBrain(store, decodeURIComponent(brainMatch[1]), await readJson(request)));
    return;
  }
  if (request.method === "DELETE" && brainMatch) {
    deleteViewBrain(store, decodeURIComponent(brainMatch[1]));
    sendJson(response, 200, { deleted: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/usage") {
    sendJson(response, 200, buildViewUsage(store, Number(url.searchParams.get("days") ?? 31) || 31));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    sendJson(response, 200, listViewAgents(store));
    return;
  }
  if (request.method === "PUT" && agentBrainsMatch) {
    sendJson(response, 200, setViewAgentBrains(store, agentBrainsMatch[1], await readJson(request)));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memories") {
    if (!store.getBrain(brainId)) throw new ViewInputError("Brain not found.");
    sendJson(response, 200, buildMemoryList(store, brainId));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/memories") {
    sendJson(response, 201, await createViewMemory(store, await readJson(request), embeddings, brainId));
    return;
  }
  if (request.method === "PATCH" && memoryMatch) {
    sendJson(response, 200, await updateViewMemory(store, decodeURIComponent(memoryMatch[1]), await readJson(request), embeddings));
    return;
  }
  if (request.method === "DELETE" && memoryMatch) {
    deleteViewMemory(store, decodeURIComponent(memoryMatch[1]));
    sendJson(response, 200, { deleted: true });
    return;
  }
  if (request.method === "GET" && versionMatch) {
    sendJson(response, 200, { versions: listViewVersions(store, decodeURIComponent(versionMatch[1])) });
    return;
  }
  if (request.method === "GET" && embeddingMatch) {
    const config = describeViewConfig();
    sendJson(
      response,
      200,
      await viewMemoryEmbedding(
        store,
        decodeURIComponent(embeddingMatch[1]),
        {
          name: config.embedder.name,
          model: config.embedder.model,
          dimensions: config.embedder.dimensions,
        },
        embeddings,
      ),
    );
    return;
  }
  if (request.method === "POST" && purgeMatch) {
    purgeViewMemory(store, decodeURIComponent(purgeMatch[1]));
    sendJson(response, 200, { purged: true });
    return;
  }
  if (request.method === "POST" && recoverMatch) {
    sendJson(response, 200, recoverViewMemory(store, decodeURIComponent(recoverMatch[1])));
    return;
  }
  if (request.method === "POST" && restoreMatch) {
    sendJson(
      response,
      200,
      await restoreViewVersion(store, decodeURIComponent(restoreMatch[1]), Number(restoreMatch[2]), embeddings),
    );
    return;
  }
  if (request.method === "GET" && !url.pathname.startsWith("/api/") && serveWeb(url.pathname, response)) return;
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

export function startViewer(
  store: BrainStore,
  port: number,
  embeddings: EmbeddingProvider = createEmbeddingProvider(),
): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    void handle(store, embeddings, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : "Couldn’t save that memory.";
      sendJson(response, error instanceof ViewInputError ? 400 : 500, { error: message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
      void reembedMismatched(store, embeddings).catch((error: unknown) => {
        console.error("[make0-brain] re-embed failed:", error);
      });
    });
  });
}
