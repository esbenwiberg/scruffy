import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./boot.js";
import { REPO, SCENARIOS, signBody, webhookBody } from "../fixtures/scenarios.js";

const OUTCOME_TO_CONCLUSION = { allow: "success", block: "failure", indeterminate: "neutral" } as const;

let h: Harness;

beforeAll(async () => {
  h = await bootHarness();
});

afterAll(async () => {
  await h.pool.end();
});

describe("end-to-end poison gate over seeded PRs", () => {
  for (const scenario of Object.values(SCENARIOS)) {
    it(`${scenario.name} -> ${scenario.expectedOutcome}`, async () => {
      const subject = { repository: REPO, commitSha: scenario.commitSha };
      h.scm.seedChangedFiles(subject, scenario.files);

      const body = webhookBody(scenario);
      const res = await h.scruffy.handleWebhook(await signBody(body), body);
      expect(res.handled).toBe(true);

      await h.scruffy.flushEffects();

      const checks = h.scm.recordedCheckRuns().filter((c) => c.input.subject.commitSha === scenario.commitSha);
      expect(checks).toHaveLength(1);
      expect(checks[0]!.input.conclusion).toBe(OUTCOME_TO_CONCLUSION[scenario.expectedOutcome]);
    });
  }

  it("rejects a webhook with an invalid signature", async () => {
    const body = webhookBody(SCENARIOS.clean!);
    await expect(h.scruffy.handleWebhook("sha256=bogus", body)).rejects.toThrow(/signature/);
  });

  it("is idempotent under duplicate delivery: one run, one check run", async () => {
    const scenario = SCENARIOS.realSecret!;
    const subject = { repository: REPO, commitSha: scenario.commitSha };
    h.scm.seedChangedFiles(subject, scenario.files);
    const body = webhookBody(scenario, "synchronize");
    const sig = await signBody(body);

    const first = await h.scruffy.handleWebhook(sig, body);
    const second = await h.scruffy.handleWebhook(sig, body);
    await h.scruffy.flushEffects();

    // Same durable run reconciled, not a duplicate.
    expect(second.runId).toBe(first.runId);
    const checks = h.scm.recordedCheckRuns().filter((c) => c.input.subject.commitSha === scenario.commitSha);
    expect(checks).toHaveLength(1);
    expect(await h.scruffy.outbox.countPending()).toBe(0);
  });
});
