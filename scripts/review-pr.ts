import { execFileSync } from "node:child_process";
import { SystemClock, UuidIdGenerator } from "../src/platform/clock.js";
import { createPool } from "../src/persistence/db.js";
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

function gh(args: string[]): any {
  const out = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(out);
}

function usage(): never {
  console.error("usage: npm run scruffy:review -- <owner/repo> <pr-number>");
  process.exit(2);
}

async function main(): Promise<void> {
  const [repo, prArg] = process.argv.slice(2);
  if (!repo || !repo.includes("/") || !prArg || !/^\d+$/.test(prArg)) usage();

  // Resolve the PR head sha (full 40-char) + URL from GitHub via the gh session.
  let pr: { head: { sha: string }; html_url: string };
  try {
    pr = gh(["api", `repos/${repo}/pulls/${prArg}`]);
  } catch (err) {
    console.error(`Could not read ${repo}#${prArg} via gh — is gh authenticated and the repo accessible?`);
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
  const headSha = pr.head.sha;
  const subject = SubjectRevision.parse({ repository: repo, commitSha: headSha });

  const pool = createPool();
  await migrate(pool); // idempotent; ensures the schema exists

  const scruffy = new Scruffy({
    pool,
    clock: new SystemClock(),
    ids: new UuidIdGenerator(),
    policy: POLICY,
    // gh-backed adapter for BOTH read and write; status links back to the PR.
    scmReader: new GhCliScm({ targetUrl: pr.html_url }),
    scmWriter: new GhCliScm({ targetUrl: pr.html_url }),
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    fixers: defaultFixers(),
    webhookSecret: "unused-in-manual-trigger",
  });

  console.log(`Reviewing ${repo}#${prArg} @ ${headSha.slice(0, 12)} …`);

  try {
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
      const statuses: { state: string; context: string; target_url: string | null }[] = gh([
        "api",
        `repos/${repo}/commits/${headSha}/statuses`,
      ]);
      const ours = statuses.find((s) => s.context === "scruffy/poison");
      if (ours) console.log(`Status    : ${ours.state}  (context scruffy/poison — shadow, non-required)`);
    } catch {
      // Non-fatal: the decision + effect count above are the source of truth.
    }
    console.log(`PR        : ${pr.html_url}`);

    if (flushed === 0) {
      console.error("\nWARNING: no effect was dispatched — the status may not have been posted. Check gh push access.");
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

await main();
