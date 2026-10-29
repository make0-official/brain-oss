import fs from "node:fs";
import path from "node:path";
import { build } from "vite";

/** The viewer serves `dist/web`; build it once when a fresh checkout runs the tests. */
export default async function setup(): Promise<void> {
  const root = path.resolve(import.meta.dirname, "..");
  if (fs.existsSync(path.join(root, "dist/web/index.html"))) return;
  await build({ configFile: path.join(root, "web/vite.config.ts"), logLevel: "warn" });
}
