import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    setupFiles: ["tests/setup-env.ts"],
    globalSetup: process.env.SKIP_DB_SETUP ? [] : ["tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
