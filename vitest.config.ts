import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Postgres-backed tests share a single database; keep them serial to avoid
    // cross-test interference until we introduce per-worker schemas.
    //
    // `fileParallelism: false` only serializes across test *files* — it does not
    // stop tests declared with `test.concurrent`/`describe.concurrent` from
    // running simultaneously within a file against the shared DB. To make the
    // serialization intent robust rather than incidental, we also force
    // in-file serial execution and cap concurrency to 1. Do NOT introduce
    // `.concurrent` tests until per-worker schemas exist; these settings will
    // neutralize them but the intent is that concurrent tests stay out.
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: { concurrent: false },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
