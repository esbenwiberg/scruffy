import { describe, expect, it } from "vitest";
import {
  aggregateRequiredWorkflows,
  classifyRequiredWorkflow,
  type ClassifiedRequiredWorkflow,
  type RequiredWorkflowEvidence,
  type RequiredWorkflowState,
  type WorkflowRunResolution,
} from "../../src/domain/release/required-workflow-evidence.js";

/**
 * Provider-neutral classification and aggregation of required-workflow evidence.
 * These are pure functions of a resolution, so the tests build evidence directly —
 * no adapter, no network. Only an exact completed `success` is a pass; every
 * terminal non-success is exception-eligible; pending/absent/unverifiable are
 * distinct and non-approvable.
 */

const PATH = ".github/workflows/ci.yml";

function evidence(
  status: string,
  conclusion: string | null,
  overrides: Partial<RequiredWorkflowEvidence> = {},
): RequiredWorkflowEvidence {
  return {
    workflowId: 10,
    workflowPath: PATH,
    runId: 900,
    runAttempt: 1,
    event: "push",
    branch: "main",
    candidateSha: "a".repeat(40),
    status,
    conclusion,
    url: `https://github.com/acme/widgets/actions/runs/900`,
    ...overrides,
  };
}

/** Classify a resolved run directly to its state. */
function stateOf(status: string, conclusion: string | null): RequiredWorkflowState {
  return classifyRequiredWorkflow({ kind: "resolved", evidence: evidence(status, conclusion) }).state;
}

describe("required workflow state classification", () => {
  it("passes only an exact completed success", () => {
    expect(stateOf("completed", "success")).toBe("passed");
  });

  it("classifies every terminal non-success conclusion as exception-eligible terminal-failed", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "neutral",
      "skipped",
      "stale",
      "startup_failure",
    ]) {
      expect(stateOf("completed", conclusion)).toBe("terminal-failed");
    }
  });

  it("classifies every non-completed status as pending", () => {
    for (const status of ["queued", "in_progress", "requested", "waiting", "pending"]) {
      expect(stateOf(status, null)).toBe("pending");
    }
  });

  it("classifies malformed provider data as unverifiable, never green or failed", () => {
    // A completed run with a null or unrecognized conclusion is not interpretable.
    expect(stateOf("completed", null)).toBe("unverifiable");
    expect(stateOf("completed", "banana")).toBe("unverifiable");
    // A non-completed run with an unrecognized status is likewise malformed.
    expect(stateOf("frobnicating", null)).toBe("unverifiable");
  });

  it("preserves provider absence and provider failure as distinct resolutions", () => {
    const absent: WorkflowRunResolution = { kind: "absent", workflowPath: PATH };
    const unverifiable: WorkflowRunResolution = {
      kind: "unverifiable",
      workflowPath: PATH,
      detail: "api failure",
    };
    expect(classifyRequiredWorkflow(absent)).toEqual({ workflowPath: PATH, state: "absent" });
    expect(classifyRequiredWorkflow(unverifiable)).toMatchObject({
      workflowPath: PATH,
      state: "unverifiable",
      detail: "api failure",
    });
  });

  it("carries the resolved evidence through classification for a passing run", () => {
    const classified = classifyRequiredWorkflow({
      kind: "resolved",
      evidence: evidence("completed", "success"),
    });
    expect(classified.evidence?.runId).toBe(900);
    expect(classified.state).toBe("passed");
  });
});

describe("multiple required workflow aggregation", () => {
  const w = (path: string, state: RequiredWorkflowState): ClassifiedRequiredWorkflow => ({
    workflowPath: path,
    state,
  });

  it("is satisfied only when every workflow passed", () => {
    const agg = aggregateRequiredWorkflows([w("a.yml", "passed"), w("b.yml", "passed")]);
    expect(agg.outcome).toBe("satisfied");
    expect(agg.reasonCode).toBe("required_workflows_satisfied");
  });

  it("is exception-eligible when all workflows are terminal and at least one failed", () => {
    const agg = aggregateRequiredWorkflows([w("a.yml", "passed"), w("b.yml", "terminal-failed")]);
    expect(agg.outcome).toBe("exception-eligible");
    expect(agg.reasonCode).toBe("required_workflow_failed");
  });

  it("is not-ready (retryable) when any workflow is pending and none is absent/unverifiable", () => {
    const agg = aggregateRequiredWorkflows([w("a.yml", "passed"), w("b.yml", "pending")]);
    expect(agg.outcome).toBe("not-ready");
    expect(agg.reasonCode).toBe("required_workflow_pending");
  });

  it("fails closed on absence, and absence dominates pending and a terminal failure", () => {
    const agg = aggregateRequiredWorkflows([
      w("a.yml", "terminal-failed"),
      w("b.yml", "pending"),
      w("c.yml", "absent"),
    ]);
    expect(agg.outcome).toBe("fail-closed");
    expect(agg.reasonCode).toBe("required_workflow_absent");
  });

  it("fails closed on unverifiable, which dominates absent, pending, and terminal failure", () => {
    const agg = aggregateRequiredWorkflows([
      w("a.yml", "terminal-failed"),
      w("b.yml", "pending"),
      w("c.yml", "absent"),
      w("d.yml", "unverifiable"),
    ]);
    expect(agg.outcome).toBe("fail-closed");
    expect(agg.reasonCode).toBe("required_workflow_unverifiable");
  });

  it("does not offer an exception while any workflow is still pending", () => {
    // A failed workflow alongside a pending one is NOT exception-eligible: the pending
    // one may still fail or pass, so the failed set is not yet the whole picture.
    const agg = aggregateRequiredWorkflows([
      w("a.yml", "terminal-failed"),
      w("b.yml", "pending"),
    ]);
    expect(agg.outcome).toBe("not-ready");
  });

  it("fails closed on an empty workflow set — never an implicit pass", () => {
    const agg = aggregateRequiredWorkflows([]);
    expect(agg.outcome).toBe("fail-closed");
  });
});
