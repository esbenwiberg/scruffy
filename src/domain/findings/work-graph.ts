import { z } from "zod";
import { AnalysisCoverage, type CoverageGap, type CoverageGapCode } from "../evidence/coverage.js";
import { ValidationOutcome } from "../evidence/types.js";
import { ProposedEdit } from "../fixes/types.js";
import { NightlyReportIdentity, RemediationProvenance, coverageWorkItemId, findingWorkItemId, runWorkItemId } from "./work-identity.js";

/**
 * The nightly report/work graph: the durable, first-class shape every later slice
 * of the self-review lifecycle consumes (issue publication, remediation, PR
 * lifecycle, scheduling).
 *
 * WHY THIS EXISTS. The gate previously carried ONE overloaded axis per finding —
 * `suppress | report | propose_fix` — which answered two unrelated questions at
 * once: "should a human see this?" and "did a fixer produce a patch?". That shape
 * cannot express the product loop, because the loop wants to ATTEMPT a fix for
 * every surviving finding: a finding with no patch yet is not less real, and a
 * finding with a patch is not thereby resolved. So the axes are independent here:
 *
 *   visibility   suppressed | surfaced                 -- should a human see it
 *   resolution   open | awaiting_verification | resolved | dismissed
 *   remediation  pending | generating | proposed | unavailable | failed
 *   delivery     queued | draft_open | ready_open | delivery_failed
 *   proposal CI  unknown | pending | passed | failed
 *   merge        open | closed_unmerged | merged
 *
 * Two invariants are load-bearing and enforced by the runtime schemas below
 * rather than left to convention:
 *  - a SUPPRESSED finding produces no human work at all (it stays in the audit
 *    record, and only there);
 *  - a merged/green/approved PR is NOT resolution. `resolved` is reachable only
 *    through `awaiting_verification`, which itself requires a merged proposal —
 *    so nothing in this module can be made to say "fixed" because a PR landed.
 *
 * Pure: no IO, no clock, no randomness. The planner is a function of the report.
 */

/** Should a human see this finding? Independent of whether anyone can fix it. */
export const FindingVisibility = z.enum(["suppressed", "surfaced"]);
export type FindingVisibility = z.infer<typeof FindingVisibility>;

/**
 * Why a finding is surfaced or suppressed. Stable reason codes — part of the
 * audit contract, never free-form. Shared with the nightly kernel so the gate and
 * the durable report speak ONE vocabulary.
 */
export const FindingVisibilityReason = z.enum([
  "not_reportable_class",
  "refuted",
  "fixable_validated",
  "reportable_validated",
  "reportable_unvalidated",
  "fix_unavailable",
]);
export type FindingVisibilityReason = z.infer<typeof FindingVisibilityReason>;

/**
 * Has the underlying defect been dealt with? Humans retain dismissal authority
 * and Scruffy retains verification duty, so neither a PR nor a merge appears on
 * this axis at all.
 */
export const FindingResolution = z.enum(["open", "awaiting_verification", "resolved", "dismissed"]);
export type FindingResolution = z.infer<typeof FindingResolution>;

/** How far the remediation ATTEMPT for a finding has got. */
export const RemediationState = z.enum(["pending", "generating", "proposed", "unavailable", "failed"]);
export type RemediationState = z.infer<typeof RemediationState>;

/** Why remediation is in its current state. Stable codes. */
export const RemediationReason = z.enum([
  /** No attempt is owed: the finding is not surfaced. */
  "not_surfaced",
  /** Surfaced and awaiting an attempt (a later slice attempts every one). */
  "attempt_owed",
  /** A deterministic fixer produced a patch. */
  "deterministic_patch_ready",
  /** Policy considers the class fixable but no registered fixer could patch it. */
  "fixer_declined",
  /** The attempt ran and failed (provider error, malformed output). */
  "attempt_failed",
]);
export type RemediationReason = z.infer<typeof RemediationReason>;

/** Has the proposal reached the SCM as a pull request, and how? */
export const ProposalDelivery = z.enum(["queued", "draft_open", "ready_open", "delivery_failed"]);
export type ProposalDelivery = z.infer<typeof ProposalDelivery>;

/** Repository-owned CI verdict for the proposal's head sha. Evidence, not truth. */
export const ProposalCiState = z.enum(["unknown", "pending", "passed", "failed"]);
export type ProposalCiState = z.infer<typeof ProposalCiState>;

export const ProposalMergeState = z.enum(["open", "closed_unmerged", "merged"]);
export type ProposalMergeState = z.infer<typeof ProposalMergeState>;

/**
 * Legal transitions per axis. Exhaustive `Record<State, State[]>` maps, so adding
 * a state is a compile error until its outgoing edges are declared — the same
 * discipline the gate kernels use for their switch statements.
 */
const RESOLUTION_TRANSITIONS: Record<FindingResolution, readonly FindingResolution[]> = {
  // A finding can be dismissed by a human at any point before it is settled, and
  // reaches `resolved` ONLY via verification of an immutable post-merge candidate.
  open: ["awaiting_verification", "dismissed"],
  // Verification may confirm (resolved), fail to confirm (back to open), or a
  // human may dismiss it. Indeterminate verification MUST NOT resolve.
  awaiting_verification: ["open", "resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

const REMEDIATION_TRANSITIONS: Record<RemediationState, readonly RemediationState[]> = {
  pending: ["generating", "unavailable", "failed"],
  generating: ["proposed", "unavailable", "failed"],
  // A superseded proposal may be re-attempted; nothing is terminal while the
  // finding itself is open.
  proposed: ["pending"],
  unavailable: ["pending"],
  failed: ["pending"],
};

const DELIVERY_TRANSITIONS: Record<ProposalDelivery, readonly ProposalDelivery[]> = {
  queued: ["draft_open", "ready_open", "delivery_failed"],
  // A draft may be promoted once its uncertainty is cleared; a ready PR is never
  // silently demoted by Scruffy.
  draft_open: ["ready_open"],
  ready_open: [],
  delivery_failed: ["queued"],
};

const CI_TRANSITIONS: Record<ProposalCiState, readonly ProposalCiState[]> = {
  unknown: ["pending", "passed", "failed"],
  pending: ["passed", "failed"],
  // A new push to the PR head re-opens CI; a verdict is never final for a branch.
  passed: ["pending", "failed"],
  failed: ["pending", "passed"],
};

const MERGE_TRANSITIONS: Record<ProposalMergeState, readonly ProposalMergeState[]> = {
  open: ["closed_unmerged", "merged"],
  // A closed PR can be reopened by a human; a merge is final.
  closed_unmerged: ["open"],
  merged: [],
};

/** Outcome of a proposed lifecycle move. `reason` is a stable, loggable code. */
export type TransitionCheck = { legal: true } | { legal: false; reason: "terminal_state" | "illegal_transition" };

function check<S extends string>(table: Record<S, readonly S[]>, from: S, to: S): TransitionCheck {
  const allowed = table[from];
  if (allowed.includes(to)) return { legal: true };
  return { legal: false, reason: allowed.length === 0 ? "terminal_state" : "illegal_transition" };
}

export const canTransitionResolution = (from: FindingResolution, to: FindingResolution): TransitionCheck =>
  check(RESOLUTION_TRANSITIONS, from, to);
export const canTransitionRemediation = (from: RemediationState, to: RemediationState): TransitionCheck =>
  check(REMEDIATION_TRANSITIONS, from, to);
export const canTransitionDelivery = (from: ProposalDelivery, to: ProposalDelivery): TransitionCheck =>
  check(DELIVERY_TRANSITIONS, from, to);
export const canTransitionCi = (from: ProposalCiState, to: ProposalCiState): TransitionCheck =>
  check(CI_TRANSITIONS, from, to);
export const canTransitionMerge = (from: ProposalMergeState, to: ProposalMergeState): TransitionCheck =>
  check(MERGE_TRANSITIONS, from, to);

/** True when no further move is possible on the resolution axis. */
export const isSettledResolution = (state: FindingResolution): boolean => RESOLUTION_TRANSITIONS[state].length === 0;

/**
 * A recorded lifecycle move. The history is the audit trail, so `at` is supplied
 * by the caller's clock rather than read here (the domain stays pure).
 */
export const LifecycleAxis = z.enum(["resolution", "remediation", "delivery", "ci", "merge"]);
export type LifecycleAxis = z.infer<typeof LifecycleAxis>;

export const LifecycleTransition = z.object({
  axis: LifecycleAxis,
  /** Null for the record created alongside the entity itself. */
  from: z.string().min(1).nullable(),
  to: z.string().min(1),
  reason: z.string().min(1),
});
export type LifecycleTransition = z.infer<typeof LifecycleTransition>;

/**
 * A concrete patch proposal for one finding occurrence. `branch` is derived from
 * the proposal identity by the caller and doubles as the SCM idempotency key, so
 * the same proposal delivered twice is one PR and a later candidate's proposal can
 * never match an older closed PR.
 */
export const FixProposalRecord = z.object({
  proposalId: z.string().min(1),
  occurrenceId: z.string().min(1),
  provenance: RemediationProvenance,
  branch: z.string().min(1),
  edits: z.array(ProposedEdit).min(1),
  delivery: ProposalDelivery,
  ci: ProposalCiState,
  merge: ProposalMergeState,
});
export type FixProposalRecord = z.infer<typeof FixProposalRecord>;

export const RemediationRecord = z
  .object({
    state: RemediationState,
    reason: RemediationReason,
    proposal: FixProposalRecord.nullable(),
  })
  .superRefine((record, ctx) => {
    // `proposed` and "has a proposal" are the same fact stated twice; letting them
    // disagree is how a run claims a fix it never generated (or drops one it did).
    if (record.state === "proposed" && record.proposal === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["proposal"], message: "remediation state 'proposed' requires a proposal" });
    }
    if (record.state !== "proposed" && record.proposal !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposal"],
        message: `remediation state '${record.state}' must not carry a proposal`,
      });
    }
  });
export type RemediationRecord = z.infer<typeof RemediationRecord>;

/** One deduplicated finding as recorded by a report. */
export const NightlyReportFinding = z
  .object({
    occurrenceId: z.string().min(1),
    findingKey: z.string().min(1),
    ruleId: z.string().min(1),
    defectClass: z.string().min(1),
    region: z.object({
      path: z.string().min(1),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    }),
    validation: ValidationOutcome,
    /** Whether deterministic evidence backs this finding — surfaced for ranking. */
    deterministicSupport: z.boolean(),
    visibility: FindingVisibility,
    visibilityReason: FindingVisibilityReason,
    resolution: FindingResolution,
    /** Null exactly when no remediation is owed (a suppressed finding). */
    remediation: RemediationRecord.nullable(),
  })
  .superRefine((finding, ctx) => {
    if (finding.visibility === "suppressed") {
      // A suppressed finding stays in the audit record and NOWHERE else: no work
      // item, no remediation attempt, no resolution lifecycle to walk.
      if (finding.remediation !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["remediation"],
          message: "a suppressed finding owes no remediation",
        });
      }
      if (finding.resolution !== "open") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolution"],
          message: "a suppressed finding has no resolution lifecycle; it stays 'open' in the audit record",
        });
      }
      return;
    }

    if (finding.remediation === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remediation"],
        message: "a surfaced finding owes a remediation record (every surviving finding gets an attempt)",
      });
      return;
    }
    if (finding.remediation.reason === "not_surfaced") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remediation", "reason"],
        message: "'not_surfaced' cannot explain a surfaced finding",
      });
    }
    // The product decision that must not be expressible as data: a merge is not a
    // fix. Verification is only OWED once something actually merged, so
    // `awaiting_verification` without a merged proposal is a state we refuse to
    // record at all.
    if (finding.resolution === "awaiting_verification" && finding.remediation.proposal?.merge !== "merged") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "'awaiting_verification' requires a merged proposal",
      });
    }
  });
export type NightlyReportFinding = z.infer<typeof NightlyReportFinding>;

/**
 * Coverage gap codes that make a review INCOMPLETE for watermark purposes. All
 * current codes qualify: each one means "there is change in this range I did not
 * look at", and a watermark that steps over unreviewed change is a lie that no
 * later run can detect. Kept as a named, service-owned set (not `true`) so a
 * future advisory gap class has one obvious place to be declared.
 */
export const REQUIRED_COVERAGE_GAP_CODES: readonly CoverageGapCode[] = [
  "provider_unavailable",
  "unparseable_output",
  "input_truncated",
  "output_capped",
];

export function isRequiredCoverageGap(gap: Pick<CoverageGap, "code">): boolean {
  return REQUIRED_COVERAGE_GAP_CODES.includes(gap.code);
}

/** The gaps that hold the complete-review watermark, in deterministic order. */
export function requiredCoverageGaps(coverage: AnalysisCoverage): CoverageGap[] {
  return coverage.gaps
    .filter(isRequiredCoverageGap)
    .slice()
    .sort((a, b) => a.analyzerId.localeCompare(b.analyzerId) || a.code.localeCompare(b.code));
}

export const NightlyReportSummary = z.object({
  surfaced: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
  proposals: z.number().int().nonnegative(),
  requiredGaps: z.number().int().nonnegative(),
});
export type NightlyReportSummary = z.infer<typeof NightlyReportSummary>;

/**
 * The durable nightly report. `requiredCoverageComplete` is DERIVED from coverage
 * and stored anyway, because it is the fact the watermark and the check both hang
 * off; the schema re-derives it on parse so a persisted row can never claim a
 * completeness its own coverage contradicts.
 */
export const NightlyReport = z
  .object({
    reportId: z.string().min(1),
    identity: NightlyReportIdentity,
    coverage: AnalysisCoverage,
    requiredCoverageComplete: z.boolean(),
    findings: z.array(NightlyReportFinding),
    summary: NightlyReportSummary,
  })
  .superRefine((report, ctx) => {
    const gaps = requiredCoverageGaps(report.coverage);
    if (report.requiredCoverageComplete !== (gaps.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredCoverageComplete"],
        message: "requiredCoverageComplete must agree with the coverage gaps it is derived from",
      });
    }
    const occurrences = new Set(report.findings.map((f) => f.occurrenceId));
    if (occurrences.size !== report.findings.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: "findings must be deduplicated by occurrence id" });
    }
    const expected = summarizeReportFindings(report.findings, gaps.length);
    if (
      expected.surfaced !== report.summary.surfaced ||
      expected.suppressed !== report.summary.suppressed ||
      expected.proposals !== report.summary.proposals ||
      expected.requiredGaps !== report.summary.requiredGaps
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["summary"], message: "summary must agree with the findings and coverage" });
    }
  });
export type NightlyReport = z.infer<typeof NightlyReport>;

export function summarizeReportFindings(
  findings: readonly NightlyReportFinding[],
  requiredGaps: number,
): NightlyReportSummary {
  return {
    surfaced: findings.filter((f) => f.visibility === "surfaced").length,
    suppressed: findings.filter((f) => f.visibility === "suppressed").length,
    proposals: findings.filter((f) => f.remediation?.state === "proposed").length,
    requiredGaps,
  };
}

/**
 * Did this report COMPLETELY review its range? The only question the complete
 * watermark is allowed to ask. "An attempt was committed" is a different question
 * with a different answer, and conflating them is how a blind night renders clean.
 */
export function isCompleteReview(report: Pick<NightlyReport, "requiredCoverageComplete">): boolean {
  return report.requiredCoverageComplete;
}

export const NightlyWorkItemKind = z.enum(["nightly_run", "finding", "coverage_gap"]);
export type NightlyWorkItemKind = z.infer<typeof NightlyWorkItemKind>;

/**
 * The durable intent to publish one piece of human-visible work. Provider-neutral
 * on purpose: brief 02 maps a parent to a GitHub issue and children to native
 * sub-issues, but the graph itself knows nothing about GitHub.
 */
export const NightlyWorkItem = z
  .object({
    workItemId: z.string().min(1),
    reportId: z.string().min(1),
    kind: NightlyWorkItemKind,
    /** Null only for the parent. */
    parentWorkItemId: z.string().min(1).nullable(),
    /** Set for `finding` children. */
    occurrenceId: z.string().min(1).nullable(),
    /** Set for `coverage_gap` children. */
    coverageGap: z.object({ analyzerId: z.string().min(1), code: z.string().min(1) }).nullable(),
    title: z.string().min(1),
    body: z.string().min(1),
    resolution: FindingResolution,
  })
  .superRefine((item, ctx) => {
    // Mirrors the SQL check constraints on `nightly_work_items` (migration 0008): a
    // kind/field mismatch must fail here, at the domain boundary, not surface later
    // as a DB constraint violation from a planner bug.
    if (item.kind === "nightly_run") {
      if (item.parentWorkItemId !== null || item.occurrenceId !== null || item.coverageGap !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kind"],
          message: "a 'nightly_run' item must have no parent, occurrence, or coverage gap",
        });
      }
    } else if (item.kind === "finding") {
      if (item.parentWorkItemId === null || item.occurrenceId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kind"],
          message: "a 'finding' item must have a parent and an occurrence id",
        });
      }
      if (item.coverageGap !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coverageGap"], message: "a 'finding' item must not carry a coverage gap" });
      }
    } else {
      if (item.parentWorkItemId === null || item.coverageGap === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kind"],
          message: "a 'coverage_gap' item must have a parent and a coverage gap",
        });
      }
      if (item.occurrenceId !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["occurrenceId"], message: "a 'coverage_gap' item must not carry an occurrence id" });
      }
    }
  });
export type NightlyWorkItem = z.infer<typeof NightlyWorkItem>;

export const NightlyWorkGraph = z
  .object({
    /** Null exactly when the run has nothing for a human: complete and clean. */
    parent: NightlyWorkItem.nullable(),
    children: z.array(NightlyWorkItem),
  })
  .superRefine((graph, ctx) => {
    if (graph.parent === null) {
      if (graph.children.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["children"], message: "children require a parent work item" });
      }
      return;
    }
    if (graph.parent.kind !== "nightly_run" || graph.parent.parentWorkItemId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parent"], message: "the parent must be a root 'nightly_run' work item" });
    }
    const ids = new Set<string>();
    for (const [index, child] of graph.children.entries()) {
      if (child.kind === "nightly_run") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["children", index], message: "a child cannot be a 'nightly_run' item" });
      }
      if (child.parentWorkItemId !== graph.parent.workItemId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["children", index], message: "child must attach to this report's parent" });
      }
      if (child.reportId !== graph.parent.reportId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["children", index], message: "child must belong to the parent's report" });
      }
      if (ids.has(child.workItemId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["children", index], message: "duplicate child work item" });
      }
      ids.add(child.workItemId);
    }
  });
export type NightlyWorkGraph = z.infer<typeof NightlyWorkGraph>;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function rangeLabel(identity: NightlyReportIdentity): string {
  return `${identity.baseSha === null ? "(first review)" : shortSha(identity.baseSha)}..${shortSha(identity.headSha)}`;
}

/**
 * Plan the work graph for a report. PURE and total:
 *  - complete coverage and nothing surfaced -> no parent, no children. A clean
 *    night must not manufacture an empty issue for a human to close.
 *  - anything surfaced, or ANY required coverage gap -> exactly one parent and one
 *    child per surfaced finding and per required gap. Blindness gets a work item
 *    of its own precisely so it cannot hide behind a quiet run.
 *  - suppressed findings are absent from the graph entirely; they live in the
 *    report's finding list, which is the audit record.
 */
export function planNightlyWorkGraph(report: NightlyReport): NightlyWorkGraph {
  const surfaced = report.findings.filter((f) => f.visibility === "surfaced");
  const gaps = requiredCoverageGaps(report.coverage);
  if (surfaced.length === 0 && gaps.length === 0) return { parent: null, children: [] };

  const identity = report.identity;
  const parentId = runWorkItemId(identity);
  const parent: NightlyWorkItem = {
    workItemId: parentId,
    reportId: report.reportId,
    kind: "nightly_run",
    parentWorkItemId: null,
    occurrenceId: null,
    coverageGap: null,
    title: `Nightly review ${identity.repository}@${identity.branch} ${rangeLabel(identity)}: ${surfaced.length} finding(s), ${gaps.length} coverage gap(s)`,
    // COVERAGE BEFORE COUNTS, deliberately. A reader who sees "0 findings" first
    // has already formed a conclusion by the time they reach the caveat; a finding
    // count is only interpretable once you know whether anything was actually read.
    body: [
      `Scruffy reviewed \`${identity.repository}\` branch \`${identity.branch}\` over the immutable range \`${rangeLabel(identity)}\`.`,
      "",
      `- base: ${identity.baseSha === null ? "_(first review of this branch)_" : `\`${identity.baseSha}\``}`,
      `- head: \`${identity.headSha}\``,
      "",
      report.requiredCoverageComplete
        ? "**Coverage: complete.** Every analyzer reviewed this whole range."
        : "**Coverage: INCOMPLETE — this run is not a clean bill of health.** The range stays unreviewed until every required gap is closed, so the complete-review watermark is held here.",
      "",
      `- required coverage gaps: ${gaps.length}`,
      `- surfaced findings: ${surfaced.length}`,
      `- suppressed (audit only, no issue): ${report.summary.suppressed}`,
      "",
      `- report: \`${report.reportId}\``,
      `- policy: \`${identity.policyVersion}\` (report schema \`${identity.schemaVersion}\`)`,
      "",
      "Each item above is tracked as its own child issue. This parent closes only when required coverage is complete and every child is verified resolved or explicitly dismissed.",
    ].join("\n"),
    resolution: "open",
  };

  const children: NightlyWorkItem[] = [];
  const seen = new Set<string>();
  for (const finding of surfaced) {
    const workItemId = findingWorkItemId({ report: identity, findingKey: finding.findingKey });
    if (seen.has(workItemId)) continue;
    seen.add(workItemId);
    children.push({
      workItemId,
      reportId: report.reportId,
      kind: "finding",
      parentWorkItemId: parentId,
      occurrenceId: finding.occurrenceId,
      coverageGap: null,
      title: `${finding.defectClass} at ${finding.region.path}:${finding.region.startLine}`,
      body: [
        `\`${finding.defectClass}\` (\`${finding.ruleId}\`) at \`${finding.region.path}:${finding.region.startLine}-${finding.region.endLine}\`.`,
        "",
        `- reviewed candidate: \`${identity.headSha}\``,
        `- adversarial validation: \`${finding.validation}\``,
        `- deterministic support: ${finding.deterministicSupport ? "yes" : "no"}`,
        `- surfaced because: \`${finding.visibilityReason}\``,
        `- remediation: \`${finding.remediation?.state ?? "none"}\` (\`${finding.remediation?.reason ?? "none"}\`)`,
        "",
        "A linked pull request, a green CI run, or a merge does not close this item: it is closed when Scruffy verifies the finding against the post-merge candidate, or when a human dismisses it.",
      ].join("\n"),
      resolution: "open",
    });
  }
  for (const gap of gaps) {
    const workItemId = coverageWorkItemId(identity, gap);
    if (seen.has(workItemId)) continue;
    seen.add(workItemId);
    children.push({
      workItemId,
      reportId: report.reportId,
      kind: "coverage_gap",
      parentWorkItemId: parentId,
      occurrenceId: null,
      coverageGap: { analyzerId: gap.analyzerId, code: gap.code },
      title: `Coverage gap: ${gap.analyzerId} (${gap.code})`,
      body: [
        `\`${gap.analyzerId}\` did not review \`${rangeLabel(identity)}\` completely (\`${gap.code}\`).`,
        "",
        `Detail: ${gap.detail || "(none reported)"}`,
        "",
        "Until this gap is closed the range is NOT reviewed: a quiet analyzer that could not look is indistinguishable from a clean one, so the complete-review watermark is held here deliberately.",
      ].join("\n"),
      resolution: "open",
    });
  }

  return { parent, children };
}
