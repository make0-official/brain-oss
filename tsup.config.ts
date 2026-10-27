import fs from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
  async onSuccess() {
    fs.copyFileSync("src/view/page.html", "dist/page.html");
    fs.copyFileSync("src/view/logo.png", "dist/logo.png");
  },
});
