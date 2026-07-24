import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The hostile-runner isolation proof (test/execution) spins up ~12 real
    // Docker containers per run. It is a heavyweight *validation artifact*, not
    // a unit invariant, and — because it churns Docker Desktop's VM — it starves
    // the co-located Postgres container, inflating every DB-backed harness file
    // that follows it (~7s suite → ~4min). Keep it out of the default `npm test`
    // and run it explicitly via `npm run test:isolation`.
    exclude: ["node_modules/**", "dist/**", "test/execution/**"],
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
