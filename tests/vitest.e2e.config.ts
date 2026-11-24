// E2E + security suites against the running compose stack (make test-e2e). Sequential: they share one gateway.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts", "security/**/*.spec.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
