import { createHash } from "node:crypto";
import { z } from "zod";
import { Finding } from "../evidence/types.js";
import { WHOLE_ANALYSIS, type AnalysisCoverage } from "../evidence/coverage.js";
import type { ReleaseDecision } from "../../gates/release/decision.js";

/**
 * The versioned, schema-validated ReleaseRiskReport — the first-class, inspectable
 * boundary object for one terminal release analysis. It binds an immutable release
 * range (repository, previous release SHA, candidate SHA) plus the declared evidence
 * to one honest advisory outcome, and it carries a stable, content-bound identity.
 *
 * This schema is the UNTRUSTED persistence/read boundary: raw JSON coming back from
 * Postgres (or, in later slices, a model provider) is parsed through it before it is
 * trusted (heritage scar — the same discipline as CheckRunPayload and the evidence
 * types). Persist additively; never trust the blob.
 *
 * This slice establishes the schema and seam only. The single declared evidence lane
 * is `source-analysis`, derived from the deterministic analyzers' coverage. `risks`
 * and `changeSummary` are carried but empty — the range-level LLM analyst
 * (02-range-risk-analyst) and candidate-CI lane (03-required-evidence-lanes)
 * populate them without changing this shape.
 */

export const RELEASE_REPORT_VERSION = "1" as const;

/** Stable evidence-lane IDs (design.md). Only `source-analysis` is declared this slice. */
export const EVIDENCE_LANE_IDS = ["source-analysis", "release-risk-llm", "candidate-ci"] as const;
export const EvidenceLaneId = z.enum(EVIDENCE_LANE_IDS);
export type EvidenceLaneId = z.infer<typeof EvidenceLaneId>;

/** Lane status vocabulary. A lane is `not-applicable` only through parsed service policy. */
export const LaneStatus = z.enum(["complete", "partial", "failed", "not-applicable"]);
export type LaneStatus = z.infer<typeof LaneStatus>;

/** Fixed range-level risk categories (design.md). Unused this slice; carried for later slices. */
export const RELEASE_RISK_CATEGORIES = [
  "security-and-access",
  "data-integrity",
  "compatibility",
  "operations",
  "deployment-and-rollback",
  "user-impact",
  "cross-change-interaction",
] as const;
export const ReleaseRiskCategory = z.enum(RELEASE_RISK_CATEGORIES);
export type ReleaseRiskCategory = z.infer<typeof ReleaseRiskCategory>;

/** A citation anchoring a model risk to a real changed line. Fully validated by 02. */
export const ReleaseRiskCitation = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
});
export type ReleaseRiskCitation = z.infer<typeof ReleaseRiskCitation>;

/**
 * A structured, model-asserted range-level risk. Defined here as the persisted shape
 * later slices populate; in this slice `risks` is always empty. Kept model-asserted
 * only — a risk never manufactures `stop`.
 */
export const ReleaseRisk = z.object({
  category: ReleaseRiskCategory,
  scenario: z.string().min(1),
  affectedSurface: z.string().min(1),
  impact: z.string().min(1),
  reversibility: z.string().optional(),
  detectability: z.string().optional(),
  rollback: z.string().optional(),
  uncertainty: z.string().optional(),
  citations: z.array(ReleaseRiskCitation).min(1),
});
export type ReleaseRisk = z.infer<typeof ReleaseRisk>;

/** Provenance of one analyzer that contributed to a lane. */
export const LaneAnalyzerProvenance = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
});
export type LaneAnalyzerProvenance = z.infer<typeof LaneAnalyzerProvenance>;

/**
 * One evidence lane in the manifest. Every policy-declared lane appears with its
 * required/applicable state, a status, the immutable subject SHA it was gathered
 * against, its provenance, human-readable observations, and explicit gaps.
 */
export const EvidenceLane = z.object({
  laneId: EvidenceLaneId,
  /** Whether service policy requires this lane for the candidate. */
  required: z.boolean(),
  /** Whether the lane applies at all (a not-applicable lane is applicable=false). */
  applicable: z.boolean(),
  status: LaneStatus,
  /** The exact candidate SHA this lane's evidence was gathered against. */
  subjectSha: z.string().min(1),
  provenance: z.array(LaneAnalyzerProvenance),
  /** Evidence observations for the audit trail (never parsed). */
  observations: z.array(z.string()),
  /** Explicit gaps — what the lane could NOT establish. */
  gaps: z.array(z.string()),
});
export type EvidenceLane = z.infer<typeof EvidenceLane>;

export const ReleaseReportSubject = z.object({
  repository: z.string().min(1),
  previousReleaseSha: z.string().nullable(),
  candidateSha: z.string().min(1),
});
export type ReleaseReportSubject = z.infer<typeof ReleaseReportSubject>;

export const ReleaseReportProvenance = z.object({
  analyzers: z.array(LaneAnalyzerProvenance),
  modelId: z.string().min(1).optional(),
  promptVersion: z.string().min(1).optional(),
});
export type ReleaseReportProvenance = z.infer<typeof ReleaseReportProvenance>;

// --- ReleaseDecision, expressed at the schema boundary --------------------------
//
// decision.ts owns the pure kernel and its TypeScript types; the report is the
// persistence/read boundary, so it needs a runtime schema for the decision it
// carries. These mirror decision.ts exactly; the `satisfies` check below fails to
// compile if the two ever drift.

const ReleaseReasonCode = z.enum([
  "no_release_findings",
  "stop_class_confirmed",
  "stop_class_unconfirmed",
  "signoff_class_confirmed",
  "signoff_class_unconfirmed",
  "finding_refuted",
  "not_release_relevant",
  "analysis_incomplete",
  "model_risk_present",
  "llm_lane_incomplete",
]);
const ReleaseEffect = z.enum(["stops", "escalates", "cleared", "not_relevant"]);
const ReleaseFindingDisposition = z.object({
  ruleId: z.string(),
  defectClass: z.string(),
  region: z.object({ path: z.string(), startLine: z.number() }),
  effect: ReleaseEffect,
  reason: ReleaseReasonCode,
  deterministicSupport: z.boolean(),
});
const ReleaseSummary = z.object({
  stopped: z.number(),
  escalated: z.number(),
  cleared: z.number(),
  notRelevant: z.number(),
});
const CoverageGap = z.object({
  analyzerId: z.string(),
  code: z.enum(["provider_unavailable", "unparseable_output", "input_truncated", "output_capped"]),
  detail: z.string(),
});
const AnalysisCoverageSchema = z.object({
  complete: z.boolean(),
  // `readonly` to match the domain AnalysisCoverage.gaps (readonly CoverageGap[]).
  gaps: z.array(CoverageGap).readonly(),
});
const ReleaseDecisionBase = {
  reasons: z.array(ReleaseReasonCode),
  dispositions: z.array(ReleaseFindingDisposition),
  summary: ReleaseSummary,
  coverage: AnalysisCoverageSchema,
};
export const ReleaseDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ship"), ...ReleaseDecisionBase }),
  z.object({ outcome: z.literal("sign-off-required"), ...ReleaseDecisionBase }),
  z.object({ outcome: z.literal("stop"), ...ReleaseDecisionBase }),
  z.object({ outcome: z.literal("indeterminate"), ...ReleaseDecisionBase }),
]);
// Compile-time guard: the schema and the kernel type must stay identical.
type _DecisionParity = z.infer<typeof ReleaseDecisionSchema>;
const _decisionParity = (d: ReleaseDecision): _DecisionParity => d;
const _decisionParityBack = (d: _DecisionParity): ReleaseDecision => d;
void _decisionParity;
void _decisionParityBack;

export const ReleaseRiskReport = z.object({
  reportVersion: z.literal(RELEASE_REPORT_VERSION),
  reportId: z.string().min(1),
  subject: ReleaseReportSubject,
  policyVersion: z.string().min(1),
  /** ISO timestamp. VOLATILE — deliberately excluded from the content identity. */
  generatedAt: z.string().min(1),
  provenance: ReleaseReportProvenance,
  changeSummary: z.string(),
  evidenceLanes: z.array(EvidenceLane),
  risks: z.array(ReleaseRisk),
  findings: z.array(Finding),
  decision: ReleaseDecisionSchema,
});
export type ReleaseRiskReport = z.infer<typeof ReleaseRiskReport>;

/**
 * The identity-bearing content of a report: everything except the assigned
 * `reportId` (circular) and the volatile `generatedAt`. The reportId is a digest
 * of exactly this — so equivalent committed content always yields the same
 * identity, and a changed base/candidate/policy/version/evidence/decision always
 * yields a different one.
 */
export type ReleaseReportContent = Omit<ReleaseRiskReport, "reportId" | "generatedAt">;

/**
 * Recursively sort object keys so serialization is independent of insertion order.
 * Arrays keep their order (that order is meaningful — e.g. ranked dispositions).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Stable, content-bound report identity. Binds repository, previous-release SHA,
 * candidate SHA, policy version, report version, provenance, and the full
 * evidence/decision content. Excludes `generatedAt` and is independent of object
 * key insertion order, so re-triggering one idempotent run recomputes the SAME id.
 */
export function computeReportId(content: ReleaseReportContent): string {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(content))).digest("hex");
  return `rr_${digest}`;
}

/**
 * The range-level LLM analyst's contribution to a report, when one is wired. When
 * absent, no `release-risk-llm` lane is added and the report keeps the single
 * `source-analysis` lane (the slice-01 shape). Slice 03 owns declaring the lane
 * REQUIRED in policy; this shape only carries its evidence into the report.
 */
export interface ReleaseRiskLaneInput {
  changeSummary: string;
  risks: ReleaseRisk[];
  /** Explicit coverage gaps. Empty ⇔ the analyst reviewed the whole bounded range. */
  gaps: { code: string; detail: string }[];
  /** Added lines actually reviewed, and the total added across the range. */
  reviewedLines: number;
  totalLines: number;
  /** Provenance of the analyst itself (id + version). */
  analyzer: LaneAnalyzerProvenance;
  /** The model that produced the assessment; omitted when never reached. */
  modelId?: string;
  promptVersion: string;
}

export interface AssembleReleaseReportInput {
  subject: ReleaseReportSubject;
  policyVersion: string;
  /** ISO timestamp for when the report was generated (injected clock). */
  generatedAt: string;
  provenance: ReleaseReportProvenance;
  findings: Finding[];
  decision: ReleaseDecision;
  /** Overridden by `releaseRisk.changeSummary` when a release-risk lane is present. */
  changeSummary?: string;
  /** Overridden by `releaseRisk.risks` when a release-risk lane is present. */
  risks?: ReleaseRisk[];
  /** The range-level LLM lane, when a release-risk analyst is wired (02+). */
  releaseRisk?: ReleaseRiskLaneInput;
}

/**
 * Build the source-analysis evidence lane from the deterministic analyzers'
 * coverage. In this slice source analysis is the only declared lane and is always
 * required. `complete` coverage → `complete`; a whole-analysis failure → `failed`;
 * any other gap (one blind analyzer among several) → `partial`. A gap can never be
 * read as clean — the status makes the blindness explicit.
 */
function sourceAnalysisLane(
  candidateSha: string,
  coverage: AnalysisCoverage,
  analyzers: readonly LaneAnalyzerProvenance[],
): EvidenceLane {
  const status: LaneStatus = coverage.complete
    ? "complete"
    : coverage.gaps.some((g) => g.analyzerId === WHOLE_ANALYSIS)
      ? "failed"
      : "partial";
  return {
    laneId: "source-analysis",
    required: true,
    applicable: true,
    status,
    subjectSha: candidateSha,
    provenance: analyzers.map((a) => ({ ...a })),
    observations: coverage.complete
      ? ["Deterministic analyzers reviewed the full candidate range."]
      : ["Deterministic analysis did not cover the full candidate range."],
    gaps: coverage.gaps.map((g) => `${g.analyzerId}: ${g.code} — ${g.detail}`),
  };
}

/**
 * Build the release-risk-llm evidence lane from the analyst's assessment. Status
 * is derived from coverage, never from the model: no gaps → `complete`; gaps but
 * nothing reviewed at all → `failed`; some review with a remaining gap → `partial`.
 * A gap can never be read as clean — the status makes the blindness explicit.
 */
function releaseRiskLane(candidateSha: string, input: ReleaseRiskLaneInput): EvidenceLane {
  const status: LaneStatus =
    input.gaps.length === 0 ? "complete" : input.reviewedLines === 0 ? "failed" : "partial";
  return {
    laneId: "release-risk-llm",
    required: true,
    applicable: true,
    status,
    subjectSha: candidateSha,
    provenance: [{ ...input.analyzer }],
    observations: [
      input.gaps.length === 0
        ? `Range-level model review covered ${input.reviewedLines} added line(s).`
        : `Range-level model review covered ${input.reviewedLines} of ${input.totalLines} added line(s).`,
      `Retained ${input.risks.length} model-asserted release risk(s).`,
    ],
    gaps: input.gaps.map((g) => `${g.code}: ${g.detail}`),
  };
}

/**
 * Assemble ONE report for a terminal release analysis and stamp its content-bound
 * identity. Pure over its inputs (the injected `generatedAt` is the only non-content
 * value and is excluded from identity). Parses the result through the schema so an
 * assembled report is always schema-valid at the seam, not only at the read boundary.
 */
export function assembleReleaseReport(input: AssembleReleaseReportInput): ReleaseRiskReport {
  const llm = input.releaseRisk;
  const evidenceLanes: EvidenceLane[] = [
    sourceAnalysisLane(input.subject.candidateSha, input.decision.coverage, input.provenance.analyzers),
    ...(llm ? [releaseRiskLane(input.subject.candidateSha, llm)] : []),
  ];
  const content: ReleaseReportContent = {
    reportVersion: RELEASE_REPORT_VERSION,
    subject: input.subject,
    policyVersion: input.policyVersion,
    provenance: {
      analyzers: input.provenance.analyzers,
      // Model provenance is carried at the report level only when an analyst ran.
      ...(llm?.modelId !== undefined ? { modelId: llm.modelId } : input.provenance.modelId !== undefined ? { modelId: input.provenance.modelId } : {}),
      ...(llm ? { promptVersion: llm.promptVersion } : input.provenance.promptVersion !== undefined ? { promptVersion: input.provenance.promptVersion } : {}),
    },
    changeSummary: llm?.changeSummary ?? input.changeSummary ?? "",
    evidenceLanes,
    risks: llm?.risks ?? input.risks ?? [],
    findings: input.findings,
    decision: input.decision,
  };
  return ReleaseRiskReport.parse({
    ...content,
    reportId: computeReportId(content),
    generatedAt: input.generatedAt,
  });
}

/**
 * Parse a raw persisted report (jsonb from Postgres) at the read/introspection
 * boundary. Never trust the blob — a stored report is re-validated through the
 * schema before it is read.
 */
export function parseReleaseReport(raw: unknown): ReleaseRiskReport {
  return ReleaseRiskReport.parse(raw);
}
