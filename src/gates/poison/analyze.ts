import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import { coverageFrom, type CoverageGap } from "../../domain/evidence/coverage.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { ScmReader } from "../../providers/scm/port.js";
import type { PoisonPolicy } from "../../domain/policy/types.js";
import { dedupeFindings } from "../../domain/findings/identity.js";
import { evaluatePoison, type PoisonDecision } from "./decision.js";

/**
 * Analysis orchestration: read the change, run analyzers, adversarially validate
 * each candidate, then apply the pure decision kernel. This function does IO
 * (providers) but contains no policy logic beyond delegating to evaluatePoison.
 */
export async function runPoisonAnalysis(
  subject: SubjectRevision,
  deps: { scm: ScmReader; analyzers: readonly Analyzer[]; validator: Validator; policy: PoisonPolicy },
): Promise<{ findings: Finding[]; decision: PoisonDecision }> {
  const files = await deps.scm.getChangedFiles(subject);

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

  // Dedupe before validation, as nightly and release do. Two analyzers can reach
  // the same identity on the same line; validating it twice costs a model call
  // and reports the same defect twice. Safe for the blocking gate because
  // dedupeFindings unions evidence rather than discarding a duplicate — a
  // deterministic statement can never be dropped in favour of a model-asserted
  // one, so a finding that would have blocked still blocks.
  const deduped = dedupeFindings(raw);

  // Validate each candidate independently. A validator throwing is recorded as
  // `failed` on that finding — never dropped, never treated as validated.
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

  return { findings, decision: evaluatePoison(findings, deps.policy, coverageFrom(gaps)) };
}
