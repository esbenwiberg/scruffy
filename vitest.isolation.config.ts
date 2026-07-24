import { defineConfig } from "vitest/config";

// The hostile-runner isolation proof (ADR-0003 validation #5, local half). It is
// kept OUT of the default `npm test` config because it spins up ~12 real Docker
// containers and churns Docker Desktop's VM hard enough to starve the co-located
// Postgres container, inflating every DB-backed harness file that runs after it.
// Run it on its own via `npm run test:isolation`.
export default defineConfig({
  test: {
    include: ["test/execution/**/*.test.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: { concurrent: false },
    hookTimeout: 120_000, // first run may pull the sandbox image
    testTimeout: 30_000,
  },
});
