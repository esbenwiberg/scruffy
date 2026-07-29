import { pathToFileURL } from "node:url";
import { SystemClock, UuidIdGenerator } from "../platform/clock.js";
import { createPool } from "../persistence/db.js";
import { migrate } from "../persistence/migrate.js";
import { Scruffy } from "../app/scruffy.js";
import type { ScmReader, ScmWriter } from "../providers/scm/port.js";
import {
  createScmReader,
  createScmWriter,
  resolveScmReaderBackend,
  resolveScmWriterBackend,
  type ScmReaderBackend,
  type ScmWriterBackend,
} from "../providers/scm/factory.js";
import {
  defaultAnalyzers,
  defaultFixers,
  defaultPolicy,
  defaultValidator,
} from "../providers/registry.js";
import { createModelProvider, resolveBackend } from "../providers/models/factory.js";
import { createWebhookServer } from "./http.js";

/**
 * Hosted entrypoint: `npm run serve` (tsx) locally, `node dist/server/main.js`
 * in the container. Boots the full durable path and runs two loops:
 *
 *   - the HTTP listener (POST /webhook, GET /healthz);
 *   - a reconcile-and-flush interval — the actual work engine. The webhook only
 *     records runs durably; this loop (and the immediate post-ack drive) does
 *     the analysis and dispatches outbox effects, and it recovers anything a
 *     crash left behind.
 *
 * Config (env only, no secrets in files):
 *   SCRUFFY_WEBHOOK_SECRET          — required; GitHub webhook HMAC secret
 *   PORT                            — listen port (default 8080)
 *   SCRUFFY_RECONCILE_INTERVAL_MS   — reconcile/flush cadence (default 10s)
 *   DATABASE_URL                    — Postgres (persistence default otherwise)
 *   SCRUFFY_SCM_READER              — gh-cli (default) | github-app (+ its env)
 *   SCRUFFY_SCM_WRITER              — gh-cli (default) | github-app (+ its env)
 *   SCRUFFY_MODEL_BACKEND           — fake (default) | claude-cli | anthropic | azure (+ its env)
 *
 * Reads and writes are selected INDEPENDENTLY through the factory (ADR-0001:
 * separate credentials). The default stays gh-cli for both — a developer's own
 * `gh` session (set GH_TOKEN in a container). Set both to `github-app` for a
 * fully App-authenticated hosted deployment that needs no `gh` login or
 * GH_TOKEN at all; see docs/product/github-app-setup.md.
 */

/** The reader + writer the server will run on, plus their selected labels. */
export interface ResolvedScmBackends {
  scmReader: ScmReader;
  scmWriter: ScmWriter;
  readerBackend: ScmReaderBackend;
  writerBackend: ScmWriterBackend;
}

/**
 * Resolve BOTH SCM backends from env and construct their adapters through the
 * factory. An unknown reader/writer value throws (the factory fails loudly), so
 * an operator typo never silently downgrades to a differently-credentialed
 * backend. github-app credentials come from the environment (SCRUFFY_GH_APP_*).
 */
export function createScmBackends(
  env: Record<string, string | undefined> = process.env,
): ResolvedScmBackends {
  const readerBackend = resolveScmReaderBackend(env);
  const writerBackend = resolveScmWriterBackend(env);
  return {
    readerBackend,
    writerBackend,
    scmReader: createScmReader(readerBackend),
    scmWriter: createScmWriter(writerBackend),
  };
}

async function main(): Promise<void> {
  const secret = process.env.SCRUFFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("SCRUFFY_WEBHOOK_SECRET must be set — refusing to accept unverifiable webhooks");
    process.exit(1);
  }
  const port = intFromEnv("PORT", 8080);
  const reconcileIntervalMs = intFromEnv("SCRUFFY_RECONCILE_INTERVAL_MS", 10_000);
  // Resolve + build BOTH backends before touching the DB, so a bad
  // SCRUFFY_SCM_READER/_WRITER (or missing App credential) fails at boot rather
  // than mid-run. With both set to github-app the server runs fully
  // App-authenticated — no gh login or GH_TOKEN required.
  const { scmReader, scmWriter, readerBackend, writerBackend } = createScmBackends();
  // Only wire a REAL model into remediation when SCRUFFY_MODEL_BACKEND explicitly
  // asks for one. Leaving `model` undefined (the "fake"/unset default) makes the
  // remediation boundary report an honest, explicit "unavailable" for any
  // non-deterministic finding rather than silently routing production findings
  // through the deterministic fake's canned non-answers.
  const modelBackend = resolveBackend();
  const model = modelBackend === "fake" ? undefined : await createModelProvider(modelBackend);

  const pool = createPool();
  await migrate(pool);

  const scruffy = new Scruffy({
    pool,
    clock: new SystemClock(),
    ids: new UuidIdGenerator(),
    policy: defaultPolicy(),
    scmReader,
    scmWriter,
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    fixers: defaultFixers(),
    ...(model !== undefined ? { model } : {}),
    webhookSecret: secret,
  });

  const server = createWebhookServer(scruffy, {
    healthCheck: async () => {
      await pool.query("select 1");
    },
  });

  // The engine. `busy` guards against overlapping passes when a pass outlasts
  // the interval — a second concurrent reconciler would just fight for leases.
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        await scruffy.reconcile();
        await scruffy.flushEffects();
      } catch (err) {
        console.error(
          `reconcile loop failed (next tick retries): ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        busy = false;
      }
    })();
  }, reconcileIntervalMs);

  server.listen(port, () => {
    console.error(
      `scruffy listening on :${port} (reader: ${readerBackend}, writer: ${writerBackend}, model: ${modelBackend}, reconcile every ${reconcileIntervalMs}ms)`,
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${signal} received — draining`);
    clearInterval(timer);
    server.close(() => {
      // In-flight background drives hold pool clients; end() waits for them.
      void pool.end().then(() => process.exit(0));
    });
    // A wedged connection must not block termination forever.
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    // An operator typo must fail loudly, not silently run on a default.
    console.error(`${name}='${raw}' is not a positive integer`);
    process.exit(1);
  }
  return value;
}

// Only boot when invoked as the entrypoint (`npm run serve` / `node dist/...`).
// Importing this module for its pure helpers (createScmBackends) in tests must
// not start the server or touch the database.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
