import { describe, expect, it, vi } from "vitest";
import { Reconciler } from "../../src/app/reconciler.js";
import type { RunStore } from "../../src/persistence/runs.js";
import type { PoisonService } from "../../src/gates/poison/service.js";
import type { EvaluationRun } from "../../src/domain/evaluation/types.js";

/**
 * Head-of-line starvation guard: a single throwing run must not abort the pass.
 * findReconcilable is deterministic, so a run that fails consistently would sit
 * at the front of every pass and block every healthy run behind it forever.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function pendingPoisonRun(id: string, commitSha: string): EvaluationRun {
  return {
    id,
    kind: "poison",
    subject: { repository: "owner/name", commitSha },
    mergeGroupSha: null,
    baseSha: null,
    branch: null,
    policyVersion: "policy-v1",
    state: "pending",
    attempt: 0,
    leaseId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("Reconciler.reconcileOnce — failure isolation", () => {
  it("still drives the second run when the first run's gate call rejects", async () => {
    const runA = pendingPoisonRun("run-a", SHA_A);
    const runB = pendingPoisonRun("run-b", SHA_B);

    const runs = {
      findReconcilable: vi.fn().mockResolvedValue([runA, runB]),
      reclaimExpired: vi.fn(),
    } as unknown as RunStore;

    const evaluate = vi.fn(async (subject: { commitSha: string }) => {
      if (subject.commitSha === SHA_A) throw new Error("transient model error");
    });
    const poison = { maxAttempts: 3, evaluate, abandon: vi.fn() } as unknown as PoisonService;

    // Silence the expected per-run error log for a clean test run.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reconciler = new Reconciler(runs, poison);

    // Does not throw despite runA rejecting.
    const acted = await reconciler.reconcileOnce();

    // runB was still driven; only it counts as acted.
    expect(acted).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledWith(runB.subject);
    errSpy.mockRestore();
  });
});
