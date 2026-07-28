import type { Finding } from "../../domain/evidence/types.js";
import { coverageFrom, type CoverageGap } from "../../domain/evidence/coverage.js";
import type { ReleasePolicy } from "../../domain/policy/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { ScmReader, RevisionRange, ChangedFile, CandidateCiEvidence } from "../../providers/scm/port.js";
import type { ReleaseRiskAnalyst, ReleaseRiskAssessment } from "../../providers/release-risk/port.js";
import { dedupeFindings } from "../../domain/findings/identity.js";
import { evaluateRelease, type ReleaseDecision, type ReleaseLlmLane, type ReleaseCiLane } from "./decision.js";
import { evaluateCandidateCi, type CandidateCiEvaluation } from "./candidate-ci.js";

/**
 * Release analysis orchestration: read the (prev-release, candidate] range's
 * changed files, run the same analyzers/validators the other gates use, DEDUPE
 * across the range (the same defect can surface from overlapping changes), then
 * apply the pure decision kernel to reach ONE aggregate outcome.
 *
 * IO lives here (providers); no policy logic beyond delegating to
 * evaluateRelease. A validator throwing is recorded as `failed` on that finding —
 * never dropped, never treated as validated. Mirrors the poison/nightly analyze
 * contract. Functional evidence only: visual QA and hostile-execution are out of
 * this slice.
 */
export async function runReleaseAnalysis(
  range: RevisionRange,
  deps: {
    scm: ScmReader;
    analyzers: readonly Analyzer[];
    validator: Validator;
    policy: ReleasePolicy;
    /**
     * Optional range-level LLM release-risk analyst. When wired, its retained
     * risks and coverage feed BOTH the decision (escalation) and the report
     * (a release-risk-llm lane). When absent the release path is unchanged —
     * source-analysis only — so a run without a model backend stays honest.
     */
    releaseRisk?: ReleaseRiskAnalyst;
  },
): Promise<{
  findings: Finding[];
  decision: ReleaseDecision;
  releaseRisk?: ReleaseRiskAssessment;
  candidateCi: CandidateCiEvaluation;
}> {
  const files = await deps.scm.getChangedFilesInRange(range);
  const subject = { repository: range.repository, commitSha: range.headSha };

  // Collect findings AND coverage gaps. An analyzer that could not run must not
  // be silently read as "found nothing" — see domain/evidence/coverage.ts.
  const raw: Finding[] = [];
  const gaps: CoverageGap[] = [];
  for (const analyzer of deps.analyzers) {
    try {
      const result = await analyzer.analyze(subject, files);
      raw.push(...result.findings);
      gaps.push(...result.gaps);
    } catch (error) {
      // An analyzer that throws outright is the most blind case of all. One
      // broken analyzer must not take the gate down, nor pass as a clean review.
      gaps.push({
        analyzerId: analyzer.id,
        code: "provider_unavailable",
        detail: error instanceof Error ? error.message : "analyzer threw",
      });
    }
  }

  // Dedupe BEFORE validation so we don't pay to validate the same defect twice.
  const deduped = dedupeFindings(raw);

  const findings: Finding[] = [];
  for (const finding of deduped) {
    let validation: Finding["validation"];
    try {
      validation = await deps.validator.validate(finding);
    } catch {
      validation = "failed";
    }
    findings.push({ ...finding, validation });
  }

  // Range-level model risk assessment (a separate lane from the line-level
  // analyzers). Its risks/coverage escalate the decision but never stop it.
  const releaseRisk = await assessReleaseRisk(deps.releaseRisk, range, files);
  const llm: ReleaseLlmLane | undefined = releaseRisk
    ? { retainedRiskCount: releaseRisk.risks.length, complete: releaseRisk.gaps.length === 0 }
    : undefined;

  // Candidate-CI lane: normalized check/status evidence for the EXACT candidate SHA,
  // evaluated against the policy-named required contexts. A read failure becomes a
  // FAILED lane (never an empty success), and a required incomplete lane escalates.
  const candidateCi = await assessCandidateCi(deps.scm, deps.policy, subject.commitSha, subject);
  const ci: ReleaseCiLane = { required: candidateCi.required, complete: candidateCi.complete };

  return {
    findings,
    decision: evaluateRelease(findings, deps.policy, coverageFrom(gaps), llm, ci),
    candidateCi,
    ...(releaseRisk ? { releaseRisk } : {}),
  };
}

/**
 * Read and evaluate the candidate-CI lane. The read is bound to the exact candidate
 * SHA. A thrown read is caught and turned into a FAILED lane — never an empty
 * successful set — so an API/schema fault escalates rather than false-greening. A
 * non-applicable lane skips the read entirely.
 */
async function assessCandidateCi(
  scm: ScmReader,
  policy: ReleasePolicy,
  candidateSha: string,
  subject: { repository: string; commitSha: string },
): Promise<CandidateCiEvaluation> {
  const ci = policy.evidence["candidate-ci"];
  if (!ci.applicable) return evaluateCandidateCi(candidateSha, ci, null, null);

  let evidence: CandidateCiEvidence | null = null;
  let readError: string | null = null;
  try {
    evidence = await scm.getCandidateCi(subject);
  } catch (error) {
    readError = error instanceof Error ? error.message : "candidate CI read failed";
  }
  return evaluateCandidateCi(candidateSha, ci, evidence, readError);
}

/**
 * Run the optional release-risk analyst defensively. The analyst is contracted
 * not to throw for a provider/parse failure (it returns a gap), but an unexpected
 * throw must still not crash the gate or masquerade as a clean review — so it is
 * recorded as a provider_unavailable gap over the whole range.
 */
async function assessReleaseRisk(
  analyst: ReleaseRiskAnalyst | undefined,
  range: RevisionRange,
  files: ChangedFile[],
): Promise<ReleaseRiskAssessment | undefined> {
  if (!analyst) return undefined;
  try {
    return await analyst.assess(range, files);
  } catch (error) {
    return {
      changeSummary: "",
      risks: [],
      gaps: [{ code: "provider_unavailable", detail: error instanceof Error ? error.message : "release-risk analyst threw" }],
      reviewedLines: 0,
      totalLines: 0,
      provenance: { modelId: null, promptVersion: "unknown" },
    };
  }
}
