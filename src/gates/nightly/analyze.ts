import type { Finding } from "../../domain/evidence/types.js";
import type { NightlyPolicy } from "../../domain/policy/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { ScmReader, RevisionRange } from "../../providers/scm/port.js";
import { dedupeFindings } from "../../domain/findings/identity.js";
import { evaluateNightly, type NightlyDecision } from "./decision.js";

/**
 * Nightly analysis orchestration: read the range's changed files, run analyzers,
 * adversarially validate each candidate, DEDUPE across the range (the same defect
 * can surface from overlapping changes), then apply the pure decision kernel.
 *
 * IO lives here (providers); no policy logic beyond delegating to evaluateNightly.
 * A validator throwing is recorded as `failed` on that finding — never dropped,
 * never treated as validated. Mirrors the poison analyze contract.
 */
export async function runNightlyAnalysis(
  range: RevisionRange,
  deps: { scm: ScmReader; analyzers: readonly Analyzer[]; validator: Validator; policy: NightlyPolicy },
): Promise<{ findings: Finding[]; decision: NightlyDecision }> {
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

  return { findings, decision: evaluateNightly(findings, deps.policy) };
}
