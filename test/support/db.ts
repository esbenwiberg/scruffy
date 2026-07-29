import { connect } from "node:net";
import { describe } from "vitest";
import { DEFAULT_DATABASE_URL } from "../../src/persistence/db.js";

/**
 * DB-backed suites need a real Postgres (README: `npm run db:up`). In an
 * environment without one — no Docker, or CI without the service — every query
 * throws `ECONNREFUSED` and the whole test FILE fails, drowning out real
 * signal. To keep `npm test` meaningful in both worlds, probe the configured
 * Postgres ONCE at load and expose `describeDb`: it runs the suite when the DB
 * is reachable and SKIPS it (rather than hard-failing) when it is not. When a
 * DB is present nothing is skipped, so CI coverage is unchanged.
 *
 * The probe is a plain TCP connect (no auth, no query) with a short timeout —
 * enough to tell "Postgres is listening" from "nothing is there".
 */

const PROBE_TIMEOUT_MS = 1500;

/**
 * When a DB is REQUIRED (SCRUFFY_REQUIRE_DB), the environment provisions Postgres
 * and it may still be starting when this module loads — the exact race
 * scripts/wait-for-db.mjs already guards `db:up` against. A single-shot probe would
 * turn that startup race into a FALSE loud failure ("connection refused" the instant
 * the suite loads), so when a DB is required we POLL for it to become ready before
 * deciding it is unreachable. The loud-failure contract is preserved: if Postgres
 * never comes up within the window, we still throw. When a DB is NOT required, we
 * keep the single-shot fast skip so local `npm test` never hangs.
 */
const REQUIRE_DB_MAX_WAIT_MS = 60_000;
const REQUIRE_DB_POLL_MS = 1000;

function target(): { host: string; port: number } {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  return { host: url.hostname, port: Number(url.port) || 5432 };
}

function probeOnce(): Promise<boolean> {
  return new Promise((resolve) => {
    const { host, port } = target();
    const socket = connect({ host, port });
    const settle = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(): Promise<boolean> {
  if (await probeOnce()) return true;
  // Fast skip when a DB is not required — never hang local runs on a missing DB.
  if (!process.env.SCRUFFY_REQUIRE_DB) return false;
  // A DB is required: wait for a still-starting Postgres before giving up.
  const deadline = Date.now() + REQUIRE_DB_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await delay(REQUIRE_DB_POLL_MS);
    if (await probeOnce()) return true;
  }
  return false;
}

/** True when the configured Postgres is reachable; false otherwise. */
export const DB_AVAILABLE = await probe();

if (!DB_AVAILABLE) {
  const { host, port } = target();
  if (process.env.SCRUFFY_REQUIRE_DB) {
    // An environment that MEANT to run the DB suites (a real CI with the service
    // enabled) sets SCRUFFY_REQUIRE_DB so a database that failed to start is a
    // loud failure, not a silent green with missing coverage.
    throw new Error(
      `[test] SCRUFFY_REQUIRE_DB is set but Postgres is not reachable at ${host}:${port} — refusing to skip DB-backed suites`,
    );
  }
  console.error(
    `[test] Postgres not reachable at ${host}:${port} — skipping DB-backed suites (run \`npm run db:up\` to include them, or set SCRUFFY_REQUIRE_DB=1 to fail instead)`,
  );
}

/**
 * Registers a suite that runs only when Postgres is reachable; otherwise the
 * suite is collected as skipped (never executed, never connecting). A thin
 * wrapper — rather than `DB_AVAILABLE ? describe : describe.skip` — so the
 * exported type is a plain, nameable signature (avoids TS4023 on declaration
 * emit from Vitest's internal suite types).
 */
export function describeDb(name: string, fn: () => void): void {
  if (DB_AVAILABLE) describe(name, fn);
  else describe.skip(name, fn);
}
