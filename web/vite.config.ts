import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const viewer = process.env.MAKE0_BRAIN_VIEW_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(root, "../dist/web"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { "/api": viewer },
  },
});
