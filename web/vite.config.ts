import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const viewer = process.env.MAKE0_BRAIN_VIEW_URL ?? "http://127.0.0.1:4173";
const devOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(root, "../dist/web"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: viewer,
        // The viewer only accepts its own Host and Origin, so present this dev page as the viewer.
        // Other origins pass through unchanged and the viewer refuses them.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, request) => {
            if (devOrigins.has(request.headers.origin ?? "")) proxyReq.setHeader("origin", new URL(viewer).origin);
          });
        },
      },
    },
  },
});
