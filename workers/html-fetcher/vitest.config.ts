import {
  cloudflarePool,
  cloudflareTest,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workersOptions = {
  wrangler: { configPath: "./wrangler.jsonc" },
};

export default defineConfig({
  plugins: [cloudflareTest(workersOptions)],
  test: {
    pool: cloudflarePool(workersOptions),
  },
});
