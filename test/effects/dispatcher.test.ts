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

/** A writer that throws for configured externalIds and records the rest. */
class FlakyWriter implements ScmWriter {
  readonly sent: string[] = [];
  constructor(private readonly throwOn: Set<string>) {}
  async upsertCheckRun(input: CheckRunInput): Promise<CheckRunResult> {
    if (this.throwOn.has(input.externalId)) throw new Error(`boom on ${input.externalId}`);
    this.sent.push(input.externalId);
    return { id: input.externalId, created: true };
  }
  async openPullRequest(_input: PullRequestInput): Promise<PullRequestResult> {
    throw new Error("not supported");
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
});
