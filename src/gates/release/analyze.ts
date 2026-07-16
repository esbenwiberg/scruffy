import type { Finding } from "../../domain/evidence/types.js";
import type { ReleasePolicy } from "../../domain/policy/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { ScmReader, RevisionRange } from "../../providers/scm/port.js";
import { dedupeFindings } from "../../domain/findings/identity.js";
import { evaluateRelease, type ReleaseDecision } from "./decision.js";

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
  deps: { scm: ScmReader; analyzers: readonly Analyzer[]; validator: Validator; policy: ReleasePolicy },
): Promise<{ findings: Finding[]; decision: ReleaseDecision }> {
  const files = await deps.scm.getChangedFilesInRange(range);
  const subject = { repository: range.repository, commitSha: range.headSha };

  const raw: Finding[] = [];
  for (const analyzer of deps.analyzers) {
    raw.push(...(await analyzer.analyze(subject, files)));
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

  return { findings, decision: evaluateRelease(findings, deps.policy) };
}
