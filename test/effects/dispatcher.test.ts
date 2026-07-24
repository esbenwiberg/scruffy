import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/platform/clock.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { OutboxStore } from "../../src/persistence/outbox.js";
import { EffectsDispatcher } from "../../src/effects/dispatcher.js";
import type {
  ChangedFile,
  CheckRunInput,
  CheckRunResult,
  PullRequestInput,
  PullRequestResult,
  RevisionRange,
  ScmWriter,
} from "../../src/providers/scm/port.js";
import type { SubjectRevision } from "../../src/domain/evidence/types.js";

/**
 * The dispatcher must isolate a throwing effect so it cannot starve the batch,
 * and dead-letter effects that can never (or no longer) succeed.
 */

const pool = createPool();
const clock = new FixedClock(new Date("2026-07-15T00:00:00Z"));
const SUBJECT: SubjectRevision = { repository: "acme/web", commitSha: "a".repeat(40) };

function checkPayload(externalId: string) {
  return {
    subject: SUBJECT,
    externalId,
    name: "scruffy/poison",
    conclusion: "success" as const,
    title: "ok",
    summary: "ok",
  };
}

/** A valid pull_request outbox payload. `edits[].rationale` is required by the
 *  schema but intentionally dropped by toPullRequestInput — the mapping test
 *  pins that stripping. `overrides` lets a case build a malformed payload. */
function prPayload(externalId: string, overrides: Record<string, unknown> = {}) {
  return {
    subject: SUBJECT,
    externalId,
    branch: "scruffy/fix-1",
    title: "Fix the thing",
    body: "This PR fixes the thing.",
    edits: [
      { path: "src/a.ts", startLine: 3, endLine: 5, replacement: "safe();", rationale: "avoids the defect" },
      { path: "src/b.ts", startLine: 10, endLine: 10, replacement: "guard();", rationale: "adds a guard" },
    ],
    ...overrides,
  };
}

/** A writer that throws for configured externalIds and records the rest. */
class FlakyWriter implements ScmWriter {
  readonly sent: string[] = [];
  readonly pullRequests: PullRequestInput[] = [];
  constructor(private readonly throwOn: Set<string>) {}
  async upsertCheckRun(input: CheckRunInput): Promise<CheckRunResult> {
    if (this.throwOn.has(input.externalId)) throw new Error(`boom on ${input.externalId}`);
    this.sent.push(input.externalId);
    return { id: input.externalId, created: true };
  }
  async openPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    if (this.throwOn.has(input.externalId)) throw new Error(`boom on ${input.externalId}`);
    this.pullRequests.push(input);
    return { number: this.pullRequests.length, created: true };
  }
  async getChangedFiles(_s: SubjectRevision): Promise<ChangedFile[]> {
    return [];
  }
  async getChangedFilesInRange(_r: RevisionRange): Promise<ChangedFile[]> {
    return [];
  }
}

let runId: string;

beforeEach(async () => {
  await migrate(pool);
  await pool.query("truncate outbox, poison_decisions, run_transitions, evaluation_runs cascade");
  await pool.query(
    `insert into evaluation_runs (id, kind, repository, commit_sha, policy_version, state, attempt, created_at, updated_at)
     values ('run_1', 'poison', $1, $2, 'p1', 'decided', 1, now(), now())`,
    [SUBJECT.repository, SUBJECT.commitSha],
  );
  runId = "run_1";
});

afterAll(async () => {
  await pool.end();
});

async function enqueue(id: string, externalId: string, effectType = "check_run", payload?: unknown): Promise<void> {
  await pool.query(
    `insert into outbox (id, run_id, effect_type, external_id, payload, status, attempts, created_at)
     values ($1, $2, $3, $4, $5, 'pending', 0, now())`,
    [id, runId, effectType, externalId, JSON.stringify(payload ?? checkPayload(externalId))],
  );
}

describe("EffectsDispatcher error isolation", () => {
  it("a throwing effect at the front of the batch does not starve the ones behind it", async () => {
    const outbox = new OutboxStore(pool, clock);
    const writer = new FlakyWriter(new Set(["pill"]));
    const dispatcher = new EffectsDispatcher(outbox, writer);

    await enqueue("obx_1", "pill"); // first by created_at, throws
    await enqueue("obx_2", "good-1");
    await enqueue("obx_3", "good-2");

    const sent = await dispatcher.dispatchOnce();
    expect(sent).toBe(2);
    expect(writer.sent.sort()).toEqual(["good-1", "good-2"]);
    // The pill is left pending (retryable), never marked sent, never blocks siblings.
    expect(await outbox.countPending()).toBe(1);
  });

  it("dead-letters an unknown effect type immediately (permanent failure)", async () => {
    const outbox = new OutboxStore(pool, clock);
    const dispatcher = new EffectsDispatcher(outbox, new FlakyWriter(new Set()));

    await enqueue("obx_1", "weird", "telepathy");
    const sent = await dispatcher.dispatchOnce();
    expect(sent).toBe(0);
    expect(await outbox.countPending()).toBe(0);
    expect(await outbox.countFailed()).toBe(1);
  });

  it("dead-letters a transient failure only after attempts are exhausted", async () => {
    const outbox = new OutboxStore(pool, clock);
    const dispatcher = new EffectsDispatcher(outbox, new FlakyWriter(new Set(["pill"])));

    await enqueue("obx_1", "pill");
    // Each pass claims + bumps attempts; it retries (stays pending) while attempts
    // are below the cap of 5, i.e. through passes 1..4.
    for (let i = 0; i < 4; i += 1) {
      await dispatcher.dispatchOnce();
      expect(await outbox.countFailed()).toBe(0);
      expect(await outbox.countPending()).toBe(1);
    }
    // Pass 5 sees attempts == 5 (>= cap) and dead-letters it.
    await dispatcher.dispatchOnce();
    expect(await outbox.countPending()).toBe(0);
    expect(await outbox.countFailed()).toBe(1);
    const { rows } = await pool.query<{ last_error: string }>("select last_error from outbox where id = 'obx_1'");
    expect(rows[0]!.last_error).toContain("boom");
  });

  it("dispatches a pull_request effect with fully-mapped input", async () => {
    const outbox = new OutboxStore(pool, clock);
    const writer = new FlakyWriter(new Set());
    const dispatcher = new EffectsDispatcher(outbox, writer);

    await enqueue("obx_1", "pr-1", "pull_request", prPayload("pr-1"));

    const sent = await dispatcher.dispatchOnce();
    expect(sent).toBe(1);
    // The captured input is the payload mapping: every field intact, and each
    // edit reduced to (path, startLine, endLine, replacement) — rationale stripped.
    expect(writer.pullRequests).toEqual([
      {
        subject: SUBJECT,
        externalId: "pr-1",
        branch: "scruffy/fix-1",
        title: "Fix the thing",
        body: "This PR fixes the thing.",
        edits: [
          { path: "src/a.ts", startLine: 3, endLine: 5, replacement: "safe();" },
          { path: "src/b.ts", startLine: 10, endLine: 10, replacement: "guard();" },
        ],
      },
    ]);
    expect(await outbox.countPending()).toBe(0);
    expect(await outbox.countFailed()).toBe(0);
    const { rows } = await pool.query<{ status: string }>("select status from outbox where id = 'obx_1'");
    expect(rows[0]!.status).toBe("sent");
  });

  it("dead-letters a malformed pull_request payload immediately (permanent failure)", async () => {
    const outbox = new OutboxStore(pool, clock);
    const writer = new FlakyWriter(new Set());
    const dispatcher = new EffectsDispatcher(outbox, writer);

    // Empty edits array violates PullRequestPayload.edits.min(1): unparseable,
    // so it can never succeed on retry and is dead-lettered on the first pass.
    await enqueue("obx_1", "pr-bad", "pull_request", prPayload("pr-bad", { edits: [] }));

    const sent = await dispatcher.dispatchOnce();
    expect(sent).toBe(0);
    expect(writer.pullRequests).toEqual([]);
    expect(await outbox.countPending()).toBe(0);
    expect(await outbox.countFailed()).toBe(1);
  });

  it("a throwing markSent is contained and does not abort the rest of the batch", async () => {
    // The isolation invariant must hold across the whole loop, not just #apply:
    // a store write (markSent) that throws is contained to its record.
    class MarkSentThrowsOnce extends OutboxStore {
      calls = 0;
      override async markSent(id: string): Promise<void> {
        this.calls += 1;
        if (this.calls === 1) throw new Error("db blip on markSent");
        return super.markSent(id);
      }
    }
    const outbox = new MarkSentThrowsOnce(pool, clock);
    const writer = new FlakyWriter(new Set());
    const dispatcher = new EffectsDispatcher(outbox, writer);

    await enqueue("obx_1", "good-1");
    await enqueue("obx_2", "good-2");

    // dispatchOnce must resolve, not reject, even though markSent threw.
    await expect(dispatcher.dispatchOnce()).resolves.toBeTypeOf("number");
    // Both effects were attempted (the second was not starved by the first's throw).
    expect(writer.sent.sort()).toEqual(["good-1", "good-2"]);
    // markSent threw for the first record, so it stays in `processing` (its
    // durable claim) — not pending, not sent, not dead-lettered. It is recovered
    // once its claim lease expires (delivery is idempotent, so re-running is
    // safe). The second record was marked sent normally.
    expect(await outbox.countPending()).toBe(0);
    expect(await outbox.countFailed()).toBe(0);
    const stuck = await pool.query<{ n: number }>("select count(*)::int as n from outbox where status = 'processing'");
    expect(stuck.rows[0]!.n).toBe(1);
  });
});
