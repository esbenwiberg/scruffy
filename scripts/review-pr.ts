import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SystemClock, UuidIdGenerator } from "../src/platform/clock.js";
import { createPool, type Pool } from "../src/persistence/db.js";
import { migrate } from "../src/persistence/migrate.js";
import { Scruffy } from "../src/app/scruffy.js";
import { GhCliScm } from "../src/providers/scm/gh-cli.js";
import {
  defaultAnalyzers,
  defaultValidator,
  defaultFixers,
  POISON_BLOCKABLE_CLASSES,
  NIGHTLY_REPORTABLE_CLASSES,
  NIGHTLY_FIXABLE_CLASSES,
  RELEASE_STOP_CLASSES,
  RELEASE_SIGNOFF_CLASSES,
} from "../src/providers/registry.js";
import type { EffectivePolicy } from "../src/domain/policy/types.js";
import { SubjectRevision } from "../src/domain/evidence/types.js";

/**
 * `npm run scruffy:review -- <owner/repo> <pr-number>` — run the poison gate against
 * a REAL PR and post a SHADOW commit status on its head commit. Reuses the `gh`
 * session for both read and write (no token in config); requires local Postgres
 * (`npm run db:up`). The status is non-required by construction, so it never blocks
 * a merge — the decision is what matters; the status makes it visible on the PR.
 *
 * Deterministic critical path: poison runs the DETERMINISTIC analyzers only (no
 * model), matching the rest of the skeleton.
 */

const POLICY: EffectivePolicy = {
  version: "policy-v1",
  poison: { blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES], requireValidation: true },
  nightly: { reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES], fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES] },
  release: { stopDefectClasses: [...RELEASE_STOP_CLASSES], signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES] },
};

function gh(args: string[]): unknown {
  const out = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(out);
}

/**
 * Minimal shape we depend on from `gh api repos/.../pulls/N`. `gh()` returns
 * `unknown` (a parsed JSON blob we do not control), so the head sha and PR URL
 * are validated here before use — an error object or unexpected payload returned
 * with exit code 0 would otherwise blow up later with an opaque `TypeError`.
 */
export const PrPayload = z.object({
  head: z.object({ sha: z.string().min(1) }),
  html_url: z.string().min(1),
});

/**
 * Resolve the PR head sha (full 40-char) + URL from GitHub via the `gh` session.
 * Both the `gh` transport error and an unexpected response shape map to the same
 * friendly message + exit 1, so a malformed payload never surfaces as a crash.
 * `runGh` is injectable so the error paths can be exercised in tests.
 */
export function resolvePrHead(
  runGh: (args: string[]) => unknown,
  repo: string,
  prArg: string,
): { headSha: string; htmlUrl: string } {
  let raw: unknown;
  try {
    raw = runGh(["api", `repos/${repo}/pulls/${prArg}`]);
  } catch (err) {
    console.error(`Could not read ${repo}#${prArg} via gh — is gh authenticated and the repo accessible?`);
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
  const parsed = PrPayload.safeParse(raw);
  if (!parsed.success) {
    console.error(`Could not read ${repo}#${prArg} via gh — unexpected response shape (no head.sha).`);
    process.exit(1);
  }
  return { headSha: parsed.data.head.sha, htmlUrl: parsed.data.html_url };
}

/**
 * Own the pool lifecycle: create it, migrate, run `body`, and ALWAYS `end()` it —
 * including when `migrate` (or `body`) throws. Migration runs inside the same
 * try/finally so a bad DATABASE_URL / schema error can't leak an open pool.
 * `createPoolFn`/`migrateFn` are injectable so teardown can be tested in isolation.
 */
export async function withPool(
  createPoolFn: () => Pool,
  migrateFn: (pool: Pool) => Promise<unknown>,
  body: (pool: Pool) => Promise<void>,
): Promise<void> {
  const pool = createPoolFn();
  try {
    await migrateFn(pool); // idempotent; ensures the schema exists
    await body(pool);
  } finally {
    await pool.end();
  }
}

function usage(): never {
  console.error("usage: npm run scruffy:review -- <owner/repo> <pr-number>");
  process.exit(2);
}

async function main(): Promise<void> {
  const [repo, prArg] = process.argv.slice(2);
  if (!repo || !repo.includes("/") || !prArg || !/^\d+$/.test(prArg)) usage();

  // Resolve the PR head sha (full 40-char) + URL from GitHub via the gh session.
  const { headSha, htmlUrl } = resolvePrHead(gh, repo, prArg);
  const subject = SubjectRevision.parse({ repository: repo, commitSha: headSha });

  // Pool creation + migration live inside withPool's try/finally, so a migrate
  // failure still ends the pool instead of leaking open connections.
  await withPool(createPool, migrate, async (pool) => {
    const scruffy = new Scruffy({
      pool,
      clock: new SystemClock(),
      ids: new UuidIdGenerator(),
      policy: POLICY,
      // gh-backed adapter for BOTH read and write; status links back to the PR.
      scmReader: new GhCliScm({ targetUrl: htmlUrl }),
      scmWriter: new GhCliScm({ targetUrl: htmlUrl }),
      analyzers: defaultAnalyzers(),
      validator: defaultValidator(),
      fixers: defaultFixers(),
      webhookSecret: "unused-in-manual-trigger",
    });

    console.log(`Reviewing ${repo}#${prArg} @ ${headSha.slice(0, 12)} …`);

    const run = await scruffy.poison.evaluate(subject);
    const flushed = await scruffy.flushEffects();

    const { rows } = await pool.query<{ outcome: string; reasons: unknown }>(
      "select outcome, reasons from poison_decisions where run_id = $1",
      [run.id],
    );
    const decision = rows[0];

    console.log("");
    console.log(`Run state : ${run.state}`);
    if (decision) {
      const reasons = Array.isArray(decision.reasons) ? decision.reasons.join(", ") : "";
      console.log(`Decision  : ${decision.outcome}${reasons ? `  (${reasons})` : ""}`);
    }
    console.log(`Effects   : ${flushed} dispatched to GitHub`);

    // Read the status back so we print exactly what landed on the PR.
    try {
      const rawStatuses = gh(["api", `repos/${repo}/commits/${headSha}/statuses`]);
      const statuses = rawStatuses as { state: string; context: string; target_url: string | null }[];
      const ours = statuses.find((s) => s.context === "scruffy/poison");
      if (ours) console.log(`Status    : ${ours.state}  (context scruffy/poison — shadow, non-required)`);
    } catch {
      // Non-fatal: the decision + effect count above are the source of truth.
    }
    console.log(`PR        : ${htmlUrl}`);

    if (flushed === 0) {
      console.error("\nWARNING: no effect was dispatched — the status may not have been posted. Check gh push access.");
      process.exitCode = 1;
    }
  });
}

// Only run when invoked as a script (`npm run scruffy:review`); importing this
// module for its pure helpers (e.g. in tests) must not execute the review.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
