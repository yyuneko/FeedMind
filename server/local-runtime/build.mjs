import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
mkdirSync(resolve(root, "dist"), { recursive: true });

const aliases = {
  name: "feedmind-local-aliases",
  setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: resolve(root, "src/cloudflare-workflow-shim.ts") }));
    build.onResolve({ filter: /^@cloudflare\/playwright$/ }, () => ({ path: resolve(root, "src/playwright-shim.ts") }));
  },
};

await build({
  absWorkingDir: root,
  entryPoints: {
    api: "./src/api.ts",
    worker: "./src/worker.ts",
    healthcheck: "./src/healthcheck.ts",
    migrate: "./src/migrate.ts",
  },
  outdir: resolve(root, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  packages: "external",
  plugins: [aliases],
  logLevel: "info",
});
