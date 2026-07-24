import { SystemClock, UuidIdGenerator } from "../platform/clock.js";
import { createPool } from "../persistence/db.js";
import { migrate } from "../persistence/migrate.js";
import { Scruffy } from "../app/scruffy.js";
import { GhCliScm } from "../providers/scm/gh-cli.js";
import { createScmWriter, resolveScmWriterBackend } from "../providers/scm/factory.js";
import { defaultAnalyzers, defaultFixers, defaultPolicy, defaultValidator } from "../providers/registry.js";
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
 *   SCRUFFY_SCM_WRITER              — gh-cli (default) | github-app (+ its env)
 *
 * Reads still go through the gh CLI (`gh` must be on PATH and authenticated —
 * in a container, set GH_TOKEN). An App-authenticated READER is a known gap,
 * tracked in the README.
 */

async function main(): Promise<void> {
  const secret = process.env.SCRUFFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("SCRUFFY_WEBHOOK_SECRET must be set — refusing to accept unverifiable webhooks");
    process.exit(1);
  }
  const port = intFromEnv("PORT", 8080);
  const reconcileIntervalMs = intFromEnv("SCRUFFY_RECONCILE_INTERVAL_MS", 10_000);
  const writerBackend = resolveScmWriterBackend();

  const pool = createPool();
  await migrate(pool);

  const scruffy = new Scruffy({
    pool,
    clock: new SystemClock(),
    ids: new UuidIdGenerator(),
    policy: defaultPolicy(),
    scmReader: new GhCliScm({}),
    scmWriter: createScmWriter(writerBackend),
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    fixers: defaultFixers(),
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
        console.error(`reconcile loop failed (next tick retries): ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        busy = false;
      }
    })();
  }, reconcileIntervalMs);

  server.listen(port, () => {
    console.error(`scruffy listening on :${port} (writer: ${writerBackend}, reconcile every ${reconcileIntervalMs}ms)`);
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

await main();
