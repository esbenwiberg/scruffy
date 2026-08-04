/**
 * Provider-neutral required-workflow evidence: the typed record persisted for one
 * configured GitHub Actions workflow, the service-owned classification of its
 * observed state, and the aggregation over every configured workflow.
 *
 * This module owns SEMANTICS, not transport. A provider adapter (the GitHub App
 * `WorkflowRunReader`) resolves the exact workflow identity and its current
 * applicable run/attempt for a candidate and hands back a `WorkflowRunResolution`;
 * everything here is a pure function of that resolution. Keeping the mapping here —
 * rather than in the adapter — is what lets Scruffy own "what an observed state
 * means" while the repository only owns "which workflows to look at".
 *
 * Load-bearing distinctions the design demands:
 *  - Only an EXACT completed `success` is green. Every other terminal conclusion is
 *    an observed failure (exception-eligible), never a pass.
 *  - `absent` (no matching run) and `unverifiable` (provider fault / ambiguity /
 *    malformed data) are DIFFERENT from a failure and from each other, and neither
 *    can authorize. A fault must never masquerade as an empty-and-green lane.
 *  - Identity is the workflow ID/path, never a display name or check-run context.
 */

/**
 * The service-owned set of accepted trigger events for v1 release-prerequisite
 * evidence. A run produced by any other event (`pull_request`, `schedule`,
 * `release`, …) is not the candidate's release evidence and is treated as if no
 * matching run existed. Fixed here, never repository-configurable.
 */
export const ACCEPTED_WORKFLOW_EVENTS = ["push", "workflow_dispatch"] as const;
export type AcceptedWorkflowEvent = (typeof ACCEPTED_WORKFLOW_EVENTS)[number];

export function isAcceptedWorkflowEvent(event: string): event is AcceptedWorkflowEvent {
  return (ACCEPTED_WORKFLOW_EVENTS as readonly string[]).includes(event);
}

/**
 * The exact target a caller resolves a required workflow against. Every field is a
 * Scruffy-resolved fact (a canonical config path, the provider's candidate SHA, and
 * the provider's default branch) — NONE of it is a caller-supplied run id, event,
 * conclusion, or workflow id, all of which are read from the provider instead.
 */
export interface RequiredWorkflowQuery {
  /** `owner/name`. */
  repository: string;
  /** Canonical `.github/workflows/*.yml|.yaml` path from the parsed configuration. */
  workflowPath: string;
  /** The exact candidate commit SHA (provider fact). */
  candidateSha: string;
  /** The repository's default branch (provider fact, never assumed `main`). */
  defaultBranch: string;
}

/**
 * Persisted evidence for ONE required workflow's current applicable run/attempt,
 * bound to the exact candidate and default branch. Every field is a provider fact;
 * the adapter validates the response shape before constructing this.
 */
export interface RequiredWorkflowEvidence {
  /** Provider workflow identity — the stable id, never a display name. */
  workflowId: number;
  /** Canonical workflow path, verified to equal the configured path. */
  workflowPath: string;
  /** The run this attempt belongs to. */
  runId: number;
  /** The CURRENT attempt number; a rerun supersedes an earlier attempt. */
  runAttempt: number;
  /** The trigger event, verified to be an accepted v1 event. */
  event: string;
  /** The run's head branch, verified to equal the default branch. */
  branch: string;
  /** The run's head SHA, verified to equal the candidate. */
  candidateSha: string;
  /** Raw provider run status (e.g. `queued`, `in_progress`, `completed`). */
  status: string;
  /** Raw provider conclusion, or null while not completed. */
  conclusion: string | null;
  /** Provider run URL, so a human never has to reconstruct it. */
  url: string;
}

/**
 * The adapter's per-workflow answer. `resolved` carries the exact current-attempt
 * evidence; `absent` is a genuine "no matching run for this workflow/candidate";
 * `unverifiable` is a provider fault, ambiguity, or malformed data. The last two
 * are NOT interchangeable and never collapse into an empty-and-green result.
 */
export type WorkflowRunResolution =
  | { kind: "resolved"; evidence: RequiredWorkflowEvidence }
  | { kind: "absent"; workflowPath: string }
  | { kind: "unverifiable"; workflowPath: string; detail: string };

/** The single service-owned state a configured workflow resolves to. */
export type RequiredWorkflowState =
  | "passed"
  | "terminal-failed"
  | "pending"
  | "absent"
  | "unverifiable";

/** One configured workflow classified into its service-owned state. */
export interface ClassifiedRequiredWorkflow {
  workflowPath: string;
  state: RequiredWorkflowState;
  /** Present only when a run resolved (`passed`/`terminal-failed`/`pending`, or a
   * `unverifiable` derived from a malformed-but-present run). */
  evidence?: RequiredWorkflowEvidence;
  /** Human-readable qualifier for `unverifiable`/`absent`; presentation, not authority. */
  detail?: string;
}

/**
 * Non-terminal statuses GitHub reports while a run has not completed. A status
 * outside this set AND not `completed` is malformed provider data → `unverifiable`,
 * never silently treated as pending or green.
 */
const PENDING_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
]);

/**
 * Terminal, non-success conclusions. Each is a completed run that did NOT pass, so
 * it is an observed result a responsible human may accept via sign-off — distinct
 * from evidence that is missing or could not be verified. `skipped`/`neutral`/
 * `stale` are explicitly here: a workflow that did not run to a green pass is not a
 * pass.
 */
const TERMINAL_NONSUCCESS_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
]);

/**
 * Classify a resolved run's raw status/conclusion into the service state. Pure and
 * provider-neutral. A `completed` run is `passed` ONLY for an exact `success`
 * conclusion; any other terminal conclusion is `terminal-failed`; a completed run
 * with a missing/unrecognized conclusion, or a not-completed run with an
 * unrecognized status, is malformed → `unverifiable`.
 */
export function classifyRunState(
  status: string,
  conclusion: string | null,
): Exclude<RequiredWorkflowState, "absent"> {
  if (status !== "completed") {
    return PENDING_STATUSES.has(status) ? "pending" : "unverifiable";
  }
  if (conclusion === "success") return "passed";
  if (conclusion !== null && TERMINAL_NONSUCCESS_CONCLUSIONS.has(conclusion)) {
    return "terminal-failed";
  }
  // A "completed" run with a null or unrecognized conclusion is malformed provider
  // data — never a silent pass and never an honest terminal failure.
  return "unverifiable";
}

/** Classify one provider resolution into its service state. */
export function classifyRequiredWorkflow(
  resolution: WorkflowRunResolution,
): ClassifiedRequiredWorkflow {
  if (resolution.kind === "absent") {
    return { workflowPath: resolution.workflowPath, state: "absent" };
  }
  if (resolution.kind === "unverifiable") {
    return {
      workflowPath: resolution.workflowPath,
      state: "unverifiable",
      detail: resolution.detail,
    };
  }
  const evidence = resolution.evidence;
  const state = classifyRunState(evidence.status, evidence.conclusion);
  const detail =
    state === "unverifiable"
      ? `run ${evidence.runId} attempt ${evidence.runAttempt} has an uninterpretable ` +
        `status/conclusion (${evidence.status}/${evidence.conclusion ?? "null"})`
      : undefined;
  return {
    workflowPath: evidence.workflowPath,
    state,
    evidence,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Aggregate outcome over every configured workflow. `satisfied` is the only outcome
 * that permits the normal Scruffy path; `exception-eligible` is a completed-but-
 * failed set a human may sign off; `not-ready` is retryable (something is still
 * pending); `fail-closed` cannot authorize at all (evidence missing or unverifiable).
 */
export type WorkflowAggregateOutcome =
  | "satisfied"
  | "exception-eligible"
  | "not-ready"
  | "fail-closed";

/**
 * Stable reason codes for the aggregate. Presentation may change; these are the
 * durable contract downstream authority/report code branches on. The workflow-
 * failure/pending/absent/unverifiable codes mirror the design's stable reason set;
 * authority-change and baseline codes are owned by the release-authority kernel.
 */
export type RequiredWorkflowReasonCode =
  | "required_workflows_satisfied"
  | "required_workflow_failed"
  | "required_workflow_pending"
  | "required_workflow_absent"
  | "required_workflow_unverifiable";

export interface RequiredWorkflowAggregate {
  outcome: WorkflowAggregateOutcome;
  reasonCode: RequiredWorkflowReasonCode;
  workflows: ClassifiedRequiredWorkflow[];
}

/**
 * Aggregate classified workflows with CONSERVATIVE precedence. The rule is that any
 * state which cannot be safely converted to an approval dominates one that can, and
 * the least-recoverable problem is reported first:
 *
 *   unverifiable > absent > pending > terminal-failed > passed
 *
 * Consequences:
 *  - all `passed` → `satisfied` (normal path).
 *  - all terminal with at least one `terminal-failed` → `exception-eligible`
 *    (sign-off route). This requires EVERY workflow to be terminal: a single
 *    pending/absent/unverifiable workflow means the failed set is not yet the whole
 *    picture, so it cannot be offered as an exception.
 *  - any `pending` (and no absent/unverifiable) → `not-ready` (retry later).
 *  - any `absent` or `unverifiable` → `fail-closed` (no authorization); a provider
 *    fault (`unverifiable`) is reported ahead of a genuine absence.
 *
 * An empty workflow set is a defensive `fail-closed`: the parsed configuration is
 * required to be non-empty, so reaching aggregation with nothing to satisfy is a
 * caller error, never an implicit pass.
 */
export function aggregateRequiredWorkflows(
  workflows: ClassifiedRequiredWorkflow[],
): RequiredWorkflowAggregate {
  if (workflows.length === 0) {
    return { outcome: "fail-closed", reasonCode: "required_workflow_absent", workflows };
  }

  const has = (state: RequiredWorkflowState): boolean => workflows.some((w) => w.state === state);

  if (has("unverifiable")) {
    return { outcome: "fail-closed", reasonCode: "required_workflow_unverifiable", workflows };
  }
  if (has("absent")) {
    return { outcome: "fail-closed", reasonCode: "required_workflow_absent", workflows };
  }
  if (has("pending")) {
    return { outcome: "not-ready", reasonCode: "required_workflow_pending", workflows };
  }
  // Everything is terminal here (passed or terminal-failed only).
  if (has("terminal-failed")) {
    return { outcome: "exception-eligible", reasonCode: "required_workflow_failed", workflows };
  }
  return { outcome: "satisfied", reasonCode: "required_workflows_satisfied", workflows };
}

/**
 * Select the CURRENT attempt per distinct run and detect ambiguity. Grouped by run
 * id, the highest `runAttempt` wins — a rerun's newer attempt supersedes every
 * earlier conclusion for the SAME run, so an old green can never outvote a pending
 * or failed rerun. If more than one DISTINCT run id survives for the exact
 * workflow/candidate/branch/event, the current run is genuinely ambiguous and the
 * caller must treat it as unverifiable rather than pick one arbitrarily.
 *
 * Returns the single current-attempt evidence, or a discriminated ambiguity/empty
 * signal. Pure; the adapter owns the read, this owns the selection.
 */
export function selectCurrentAttempt(
  runs: readonly RequiredWorkflowEvidence[],
): { kind: "one"; evidence: RequiredWorkflowEvidence } | { kind: "none" } | { kind: "ambiguous"; runIds: number[] } {
  if (runs.length === 0) return { kind: "none" };

  const currentByRun = new Map<number, RequiredWorkflowEvidence>();
  for (const run of runs) {
    const existing = currentByRun.get(run.runId);
    if (existing === undefined || run.runAttempt > existing.runAttempt) {
      currentByRun.set(run.runId, run);
    }
  }

  const runIds = [...currentByRun.keys()].sort((a, b) => a - b);
  if (runIds.length > 1) return { kind: "ambiguous", runIds };
  return { kind: "one", evidence: currentByRun.get(runIds[0]!)! };
}
