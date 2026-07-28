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

function target(): { host: string; port: number } {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  return { host: url.hostname, port: Number(url.port) || 5432 };
}

function probe(): Promise<boolean> {
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

/** True when the configured Postgres is reachable; false otherwise. */
export const DB_AVAILABLE = await probe();

if (!DB_AVAILABLE) {
  const { host, port } = target();
  console.error(
    `[test] Postgres not reachable at ${host}:${port} — skipping DB-backed suites (run \`npm run db:up\` to include them)`,
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
