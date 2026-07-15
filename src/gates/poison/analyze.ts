import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { ScmReader } from "../../providers/scm/port.js";
import type { PoisonPolicy } from "../../domain/policy/types.js";
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

  const raw: Finding[] = [];
  for (const analyzer of deps.analyzers) {
    raw.push(...(await analyzer.analyze(subject, files)));
  }

  // Validate each candidate independently. A validator throwing is recorded as
  // `failed` on that finding — never dropped, never treated as validated.
  const findings: Finding[] = [];
  for (const finding of raw) {
    let validation: Finding["validation"];
    try {
      validation = await deps.validator.validate(finding);
    } catch {
      validation = "failed";
    }
    findings.push({ ...finding, validation });
  }

  return { findings, decision: evaluatePoison(findings, deps.policy) };
}
