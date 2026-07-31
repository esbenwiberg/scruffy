import { pathToFileURL } from "node:url";
import { SystemClock, UuidIdGenerator } from "../platform/clock.js";
import { createPool } from "../persistence/db.js";
import { migrate } from "../persistence/migrate.js";
import { Scruffy } from "../app/scruffy.js";
import type {
  ScmInstallationReader,
  ScmLifecycleReader,
  ScmReader,
  ScmWriter,
  WorkflowApprovalReader,
} from "../providers/scm/port.js";
import {
  createScmInstallationReader,
  createScmLifecycleReader,
  createScmReader,
  createScmWriter,
  createWorkflowApprovalReader,
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
  releaseRiskAnalyst,
} from "../providers/registry.js";
import { createModelProvider, resolveBackend } from "../providers/models/factory.js";
import { createWebhookServer } from "./http.js";
import {
  GithubActionsOidcVerifier,
  githubActionsOidcTrustFromEnv,
} from "../providers/identity/github-actions-oidc.js";
import { ReleaseAuthorityStore } from "../persistence/release-authority.js";
import { ReleaseAuthorityService } from "../app/release-authority.js";

/**
 * Hosted entrypoint: `npm run serve` (tsx) locally, `node dist/server/main.js`
 * in the container. Boots the full durable path and runs two loops:
 *
 *   - the HTTP listener (POST /webhook, GET /healthz);
 *   - a reconcile-and-flush interval — the actual work engine. The webhook only
 *     records runs durably; this loop (and the immediate post-ack drive) does
 *     the analysis and dispatches outbox effects, and it recovers anything a
 *     crash left behind. The same tick then reconciles the fix lifecycle —
 *     repository CI, human merges/closures, and post-merge verification — which
 *     is a no-op unless the reader backend can observe it (github-app).
 *
 * Config (env only, no secrets in files):
 *   SCRUFFY_WEBHOOK_SECRET          — required; GitHub webhook HMAC secret
 *   PORT                            — listen port (default 8080)
 *   SCRUFFY_RECONCILE_INTERVAL_MS   — reconcile/flush cadence (default 10s)
 *   DATABASE_URL                    — Postgres (persistence default otherwise)
 *   SCRUFFY_SCM_READER              — gh-cli (default) | github-app (+ its env)
 *   SCRUFFY_SCM_WRITER              — gh-cli (default) | github-app (+ its env)
 *   SCRUFFY_MODEL_BACKEND           — fake (default) | claude-cli | anthropic | azure
 *   AZURE_FOUNDRY_BASE_URL          — required for azure; HTTPS ...services.ai.azure.com/anthropic
 *   AZURE_FOUNDRY_DEPLOYMENT        — required for azure; explicit deployed model name
 *   SCRUFFY_RELEASE_OIDC_REPOSITORY / _ID / _WORKFLOW_REF / _AUDIENCE
 *   SCRUFFY_RELEASE_TARGET_ENVIRONMENT / _APPROVAL_ENVIRONMENT
 *                                  — enables the authenticated hosted release protocol
 *   SCRUFFY_NIGHTLY_CADENCE_MS      — nightly cadence per repository/branch; UNSET = no
 *                                     hosted schedule (manual `scruffy:nightly` only)
 *   SCRUFFY_NIGHTLY_TICK_MS         — how often the schedule is polled (default 5min)
 *   SCRUFFY_NIGHTLY_LEASE_MS        — attempt lease (default 30min)
 *   SCRUFFY_NIGHTLY_BATCH_SIZE      — repositories driven per tick (default 20)
 *   SCRUFFY_NIGHTLY_OWNER           — recorded lease owner (default hostname/pid)
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
  /**
   * Null on the gh-cli reader, which cannot observe PR/CI/issue lifecycle state.
   * The fix-lifecycle loop is then an explicit no-op rather than a loop that
   * quietly records nothing.
   */
  scmLifecycleReader: ScmLifecycleReader | null;
  /**
   * Null on the gh-cli reader, which cannot enumerate the App installation. The
   * hosted nightly schedule is then unavailable BY CONSTRUCTION rather than
   * silently reviewing nothing (see `resolveNightlySchedule`).
   */
  scmInstallationReader: ScmInstallationReader | null;
  /** Null on gh-cli; the App implementation requires read-only Actions permission. */
  workflowApprovalReader: WorkflowApprovalReader | null;
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
    scmLifecycleReader: createScmLifecycleReader(readerBackend),
    scmInstallationReader: createScmInstallationReader(readerBackend),
    workflowApprovalReader: createWorkflowApprovalReader(readerBackend),
  };
}

/** The hosted nightly schedule, as resolved from env. */
export interface ResolvedNightlySchedule {
  cadenceMs: number;
  leaseMs: number;
  batchSize: number;
  owner: string;
  /** How often the scheduler polls; smaller than the cadence, which gates the work. */
  tickMs: number;
}

/**
 * Resolve the hosted nightly cadence from env, or null when none is configured.
 *
 * `SCRUFFY_NIGHTLY_CADENCE_MS` is the single switch: unset means this deployment has
 * no hosted schedule and nightly runs come from the manual `scruffy:nightly` command.
 * When it IS set, the reader must be installation-capable — a cadence configured
 * against the gh-cli reader can never enumerate its own installation, and a schedule
 * that reviews nothing every night is indistinguishable from a quiet repository. That
 * is a boot-time configuration error, so it throws here rather than degrading.
 *
 * Exported (and env-injectable) so this resolution is testable without booting.
 */
export function resolveNightlySchedule(
  env: Record<string, string | undefined>,
  installationCapable: boolean,
): ResolvedNightlySchedule | null {
  const cadenceMs = positiveInt(env, "SCRUFFY_NIGHTLY_CADENCE_MS");
  if (cadenceMs === null) return null;
  if (!installationCapable) {
    throw new Error(
      "SCRUFFY_NIGHTLY_CADENCE_MS is set but SCRUFFY_SCM_READER cannot enumerate the App installation — " +
        "set SCRUFFY_SCM_READER=github-app, or unset the cadence and use the manual scruffy:nightly command",
    );
  }
  const tickMs = positiveInt(env, "SCRUFFY_NIGHTLY_TICK_MS") ?? 5 * 60_000;
  if (tickMs > cadenceMs) {
    // A poll slower than the cadence silently stretches the cadence; an operator who
    // asked for hourly reviews would get them every tick instead.
    throw new Error(
      `SCRUFFY_NIGHTLY_TICK_MS=${tickMs} is longer than SCRUFFY_NIGHTLY_CADENCE_MS=${cadenceMs} — ` +
        "the poll interval must be shorter than the cadence it drives",
    );
  }
  return {
    cadenceMs,
    tickMs,
    leaseMs: positiveInt(env, "SCRUFFY_NIGHTLY_LEASE_MS") ?? 30 * 60_000,
    batchSize: positiveInt(env, "SCRUFFY_NIGHTLY_BATCH_SIZE") ?? 20,
    // Distinct per process so a multi-replica deployment's lease owners are
    // attributable in the schedule audit row.
    owner: env.SCRUFFY_NIGHTLY_OWNER ?? `nightly-scheduler:${process.pid}`,
  };
}

/** A positive integer env value, null when unset. Throws on a typo — never defaults past it. */
function positiveInt(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name}='${raw}' is not a positive integer`);
  return value;
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
  const {
    scmReader,
    scmWriter,
    scmLifecycleReader,
    scmInstallationReader,
    workflowApprovalReader,
    readerBackend,
    writerBackend,
  } = createScmBackends();
  // Resolved before the DB too: a cadence that cannot possibly run (or a typo in one
  // of its intervals) must stop the boot, not produce silent empty nights.
  let nightlySchedule: ResolvedNightlySchedule | null;
  try {
    nightlySchedule = resolveNightlySchedule(process.env, scmInstallationReader !== null);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
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
    ...(model !== undefined ? { model, releaseRisk: releaseRiskAnalyst(model) } : {}),
    // Full release narratives belong to deployment jobs, never commit/PR checks.
    publishReleaseCheck: false,
    ...(scmLifecycleReader !== null ? { scmLifecycleReader } : {}),
    ...(scmInstallationReader !== null ? { scmInstallationReader } : {}),
    ...(nightlySchedule !== null
      ? {
          nightlySchedule: {
            cadenceMs: nightlySchedule.cadenceMs,
            leaseMs: nightlySchedule.leaseMs,
            batchSize: nightlySchedule.batchSize,
            owner: nightlySchedule.owner,
          },
        }
      : {}),
    webhookSecret: secret,
  });

  const oidcTrust = githubActionsOidcTrustFromEnv(process.env);
  if (oidcTrust !== null && workflowApprovalReader === null) {
    throw new Error(
      "hosted release OIDC is enabled but the SCM reader cannot read workflow approvals; use github-app with Actions: read",
    );
  }
  const oidcVerifier = oidcTrust === null ? null : new GithubActionsOidcVerifier(oidcTrust);
  const releaseAuthority =
    oidcTrust === null || workflowApprovalReader === null
      ? null
      : new ReleaseAuthorityService({
          scruffy,
          store: new ReleaseAuthorityStore(pool),
          approvals: workflowApprovalReader,
          clock: new SystemClock(),
          targetEnvironment: oidcTrust.targetEnvironment,
          approvalEnvironment: oidcTrust.approvalEnvironment,
        });

  const server = createWebhookServer(scruffy, {
    healthCheck: async () => {
      await pool.query("select 1");
    },
    ...(releaseAuthority !== null && oidcVerifier !== null
      ? { releaseAuthority, oidcVerifier }
      : {}),
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
        // AFTER the flush: a PR opened by this very tick is then observable on the
        // next one, and a fix PR that was just delivered already has its durable
        // number/head sha to reconcile against.
        await scruffy.reconcileFixes();
      } catch (err) {
        console.error(
          `reconcile loop failed (next tick retries): ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        busy = false;
      }
    })();
  }, reconcileIntervalMs);

  // The nightly trigger, on its OWN timer. Kept separate from the reconcile loop
  // because the two cadences are unrelated (seconds vs hours) and a long nightly
  // pass must not stall CI/merge/verification reconciliation — the morning state
  // stays current while the night's analysis is still running. Overlap is handled
  // durably by the per-branch schedule lease, so `scheduling` here is only an
  // in-process courtesy against a pass that outlasts its own tick.
  let scheduling = false;
  const nightlyTimer =
    nightlySchedule === null
      ? null
      : setInterval(() => {
          if (scheduling) return;
          scheduling = true;
          void (async () => {
            try {
              const tick = await scruffy.scheduleNightly();
              if (tick.listingError !== null) {
                console.error(`nightly schedule: ${tick.listingError}`);
              } else if (tick.claimed > 0) {
                console.error(
                  `nightly schedule: listed ${tick.listed}, eligible ${tick.eligible}, claimed ${tick.claimed}, reviewed ${tick.reviewed}`,
                );
              }
            } catch (err) {
              console.error(
                `nightly schedule tick failed (next tick retries): ${err instanceof Error ? err.message : String(err)}`,
              );
            } finally {
              scheduling = false;
            }
          })();
        }, nightlySchedule.tickMs);

  server.listen(port, () => {
    const schedule =
      nightlySchedule === null
        ? "nightly schedule: off (manual scruffy:nightly only)"
        : `nightly cadence ${nightlySchedule.cadenceMs}ms, polled every ${nightlySchedule.tickMs}ms, ${nightlySchedule.batchSize} repos/tick`;
    console.error(
      `scruffy listening on :${port} (reader: ${readerBackend}, writer: ${writerBackend}, model: ${modelBackend}, reconcile every ${reconcileIntervalMs}ms, ${schedule})`,
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${signal} received — draining`);
    clearInterval(timer);
    if (nightlyTimer !== null) clearInterval(nightlyTimer);
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
