import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { sign } from "@octokit/webhooks-methods";
import { SystemClock, UuidIdGenerator } from "../src/platform/clock.js";
import { createPool } from "../src/persistence/db.js";
import { migrate } from "../src/persistence/migrate.js";
import { Scruffy } from "../src/app/scruffy.js";
import { FakeScm } from "../src/providers/scm/fake.js";
import { defaultAnalyzers, defaultFixers, defaultPolicy, defaultValidator } from "../src/providers/registry.js";
import { createWebhookServer } from "../src/server/http.js";

/**
 * `npm run ops:measure` — ADR-0003 validation #6: measure cold start,
 * webhook-to-dispatch latency, and steady memory, and print the
 * maintainer-visible operational-steps inventory.
 *
 * This is a SCRIPT, not a test: timings are evidence about an environment, not
 * an invariant to pin (a laptop number is not a cloud number — the point is the
 * ORDER OF MAGNITUDE and the methodology, which docs/product/ops-measurement.md
 * records).
 *
 * Two instruments, deliberately separated:
 *
 *  1. COLD START + STEADY MEMORY measure the real compiled server
 *     (`node dist/server/main.js`, the exact container command) from spawn to a
 *     200 /healthz — including module load, DB connect, and the idempotent
 *     migration pass.
 *
 *  2. LATENCY measures the production `createWebhookServer` code path over a
 *     real localhost HTTP round trip and the REAL durable pipeline (Postgres:
 *     ensureRun, guarded transitions, atomic decision+outbox, dispatcher) with
 *     the SCM edge faked. That isolates scruffy's own overhead; a live run adds
 *     GitHub's API time on top, which is GitHub's number, not ours — and it
 *     keeps the instrument from firing writes at github.com every time someone
 *     measures.
 *
 * Requires local Postgres (`npm run db:up`) and a `dist/` build (the npm script
 * builds first).
 */

const execFileAsync = promisify(execFile);

const COLD_START_RUNS = 5;
const LATENCY_RUNS = 30;
const SERVER_PORT = 18734;

interface Quantiles {
  p50: number;
  p95: number;
  max: number;
}

function quantiles(samples: number[]): Quantiles {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

const fmt = (ms: number) => `${ms.toFixed(1)}ms`;

// ── 1. Cold start + steady memory: the real compiled server ─────────────────

async function waitForHealthz(port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy within ${deadlineMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function rssKb(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null; // ps unavailable — memory sampling is best-effort
  }
}

async function measureColdStart(): Promise<{ coldStartMs: number[]; bootRssMb: number | null; steadyRssMb: number | null }> {
  const samples: number[] = [];
  let bootRssMb: number | null = null;
  let steadyRssMb: number | null = null;

  for (let i = 0; i < COLD_START_RUNS; i += 1) {
    const port = SERVER_PORT + i;
    const started = performance.now();
    const child = spawn("node", ["dist/server/main.js"], {
      env: { ...process.env, SCRUFFY_WEBHOOK_SECRET: "ops-measure", PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));

    try {
      await waitForHealthz(port, 15_000);
      samples.push(performance.now() - started);

      if (i === COLD_START_RUNS - 1) {
        // Sample memory on the last instance: at boot, then after a request burst.
        bootRssMb = ((await rssKb(child.pid!)) ?? 0) / 1024 || null;
        for (let r = 0; r < 200; r += 1) await fetch(`http://127.0.0.1:${port}/healthz`);
        steadyRssMb = ((await rssKb(child.pid!)) ?? 0) / 1024 || null;
      }
    } catch (err) {
      child.kill("SIGKILL");
      throw new Error(`cold-start run ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}\nserver stderr:\n${stderr}`);
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  }
  return { coldStartMs: samples, bootRssMb, steadyRssMb };
}

// ── 2. Webhook-to-dispatch latency: production server code path, faked SCM ──

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

async function measureLatency(): Promise<{ ackMs: Quantiles; dispatchMs: Quantiles; cleanup: () => Promise<void> }> {
  const secret = "ops-measure-secret";
  const pool = createPool();
  await migrate(pool);

  // flushEffects drains the WHOLE outbox, so stray pending effects from earlier
  // local sessions get dispatched/dead-lettered by this measurement. Say so up
  // front rather than letting their dispatcher logs read as measurement noise.
  const { rows: strays } = await pool.query<{ n: string }>("select count(*) as n from outbox where status = 'pending'");
  if (Number(strays[0]?.n ?? 0) > 0) {
    console.log(`  NOTE: ${strays[0]!.n} pre-existing pending outbox effect(s) in this DB will be drained (dispatcher may log them).\n`);
  }

  const scm = new FakeScm();
  const scruffy = new Scruffy({
    pool,
    clock: new SystemClock(),
    ids: new UuidIdGenerator(),
    policy: defaultPolicy(),
    scmReader: scm,
    scmWriter: scm,
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    fixers: defaultFixers(),
    webhookSecret: secret,
  });

  // Track each background drive so a sample measures webhook POST -> decision
  // committed -> outbox effect dispatched to the SCM writer (the full pipeline).
  let driveDone: Promise<void> = Promise.resolve();
  const server = createWebhookServer(scruffy, {
    drive: (subject) => {
      driveDone = (async () => {
        await scruffy.poison.evaluate(subject);
        await scruffy.flushEffects();
      })();
      return driveDone;
    },
    log: () => {},
  });
  const base = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

  const repository = "ops-measure/local";
  const ackSamples: number[] = [];
  const dispatchSamples: number[] = [];
  const runIds: string[] = [];

  for (let i = 0; i < LATENCY_RUNS; i += 1) {
    const commitSha = randomBytes(20).toString("hex");
    scm.seedChangedFiles(
      { repository, commitSha },
      [{ path: "src/util.ts", patch: newFile([`export const v${i} = ${i};`]) }],
    );
    const body = JSON.stringify({ action: "opened", repository: { full_name: repository }, pull_request: { head: { sha: commitSha } } });
    const signature = await sign(secret, body);

    const t0 = performance.now();
    const res = await fetch(`${base}/webhook`, { method: "POST", body, headers: { "x-hub-signature-256": signature } });
    const tAck = performance.now();
    if (res.status !== 202) throw new Error(`expected 202, got ${res.status}`);
    runIds.push(((await res.json()) as { runId: string }).runId);
    await driveDone; // decision committed + effect dispatched
    const tDispatch = performance.now();

    ackSamples.push(tAck - t0);
    dispatchSamples.push(tDispatch - t0);
  }

  const cleanup = async () => {
    await new Promise((resolve) => server.close(resolve));
    // Leave the shared dev DB the way we found it.
    await pool.query("delete from outbox where run_id = any($1)", [runIds]);
    await pool.query("delete from poison_decisions where run_id = any($1)", [runIds]);
    await pool.query("delete from run_transitions where run_id = any($1)", [runIds]);
    await pool.query("delete from evaluation_runs where id = any($1)", [runIds]);
    await pool.end();
  };

  return { ackMs: quantiles(ackSamples), dispatchMs: quantiles(dispatchSamples), cleanup };
}

// ── 3. Maintainer-visible operational steps ──────────────────────────────────

const OPERATIONAL_STEPS = [
  "Provision Postgres and set DATABASE_URL (local: `npm run db:up`).",
  "Set SCRUFFY_WEBHOOK_SECRET (and writer credentials if using the github-app writer).",
  "Start the service (`npm run serve` / container CMD) — migrations apply themselves at boot.",
  "Point the GitHub webhook at POST /webhook; monitor GET /healthz.",
];
// Everything else (reconcile loop, effect dispatch, crash recovery, retry,
// dead-lettering) is self-driving — there is no scheduler or queue to operate.

// ── Report ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync("dist/server/main.js")) {
    console.error("dist/server/main.js missing — run via `npm run ops:measure` (it builds first)");
    process.exit(1);
  }

  console.log("Ops measurement — ADR-0003 validation #6");
  console.log(`(${COLD_START_RUNS} cold starts, ${LATENCY_RUNS} pipeline runs; local Postgres; SCM edge faked for latency)\n`);

  const cold = await measureColdStart();
  const q = quantiles(cold.coldStartMs);
  console.log("Cold start (spawn `node dist/server/main.js` -> 200 /healthz, incl. DB connect + idempotent migrate):");
  console.log(`  median ${fmt(q.p50)}   max ${fmt(q.max)}   runs ${cold.coldStartMs.map((s) => fmt(s)).join(", ")}`);
  console.log(
    `  RSS after boot: ${cold.bootRssMb === null ? "n/a" : `${cold.bootRssMb.toFixed(1)} MiB`}   after 200 requests: ${cold.steadyRssMb === null ? "n/a" : `${cold.steadyRssMb.toFixed(1)} MiB`}\n`,
  );

  const latency = await measureLatency();
  try {
    console.log("Webhook -> ack (signed POST /webhook -> 202; run durable):");
    console.log(`  p50 ${fmt(latency.ackMs.p50)}   p95 ${fmt(latency.ackMs.p95)}   max ${fmt(latency.ackMs.max)}`);
    console.log("Webhook -> dispatch (202 + analyze + validate + atomic decision/outbox + effect dispatched):");
    console.log(`  p50 ${fmt(latency.dispatchMs.p50)}   p95 ${fmt(latency.dispatchMs.p95)}   max ${fmt(latency.dispatchMs.max)}`);
    console.log("  (excludes GitHub API time — the SCM edge is faked so the instrument never writes outward)\n");
  } finally {
    await latency.cleanup();
  }

  console.log("Maintainer-visible operational steps:");
  OPERATIONAL_STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log("\nRecord the run in docs/product/ops-measurement.md (date, machine, numbers).");
}

await main();
