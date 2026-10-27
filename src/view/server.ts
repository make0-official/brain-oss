import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createEmbeddingProvider } from "../config";
import { reembedMismatched } from "../embeddings/reembed";
import type { EmbeddingProvider } from "../embeddings/provider";
import type { BrainStore } from "../store/store";
import { describeViewConfig } from "./config";
import { buildMemoryList } from "./list";
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

const assetDir = path.dirname(fileURLToPath(import.meta.url));

function readAsset(name: string): Buffer {
  const file = path.join(assetDir, name);
  if (!fs.existsSync(file)) throw new Error(`Missing viewer file: ${file}`);
  return fs.readFileSync(file);
}

const page = readAsset("page.html");
const logo = readAsset("logo.png");

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
  const memoryMatch = /^\/api\/memories\/([^/]+)$/.exec(url.pathname);
  const versionMatch = /^\/api\/memories\/([^/]+)\/versions$/.exec(url.pathname);
  const restoreMatch = /^\/api\/memories\/([^/]+)\/versions\/(\d+)\/restore$/.exec(url.pathname);
  const recoverMatch = /^\/api\/memories\/([^/]+)\/restore$/.exec(url.pathname);
  const embeddingMatch = /^\/api\/memories\/([^/]+)\/embedding$/.exec(url.pathname);
  const purgeMatch = /^\/api\/memories\/([^/]+)\/purge$/.exec(url.pathname);

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, describeViewConfig());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memories") {
    sendJson(response, 200, buildMemoryList(store));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/memories") {
    sendJson(response, 201, await createViewMemory(store, await readJson(request), embeddings));
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
  if (request.method === "GET" && url.pathname === "/logo.png") {
    response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
    response.end(logo);
    return;
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
    return;
  }
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
