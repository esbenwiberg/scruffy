import type { Finding } from "../evidence/types.js";

/**
 * Semantic finding identity and deduplication (ADR 0003 `domain/findings`).
 *
 * Identity is a stable (ruleId, defectClass, normalized location) tuple — the
 * heritage assessment rejected `file::category::agent` as too fragile. A nightly
 * review over a range can surface the same defect from overlapping analyses; the
 * gate must count it once. Deterministic analyzers are pure, so identity here is
 * pure too: no clock, no randomness.
 *
 * Nightly-only for now; poison is deliberately left untouched.
 */

/**
 * Stable identity key for a finding. Same defect -> same key across analyses.
 * Components are joined with a space; none of them (defect class, rule id,
 * normalized path, line numbers) contains whitespace, so the join is unambiguous.
 */
export function findingKey(finding: Finding): string {
  const { path, startLine, endLine } = finding.primaryRegion;
  return [finding.defectClass, finding.ruleId, path, String(startLine), String(endLine)].join(" ");
}

/**
 * Collapse duplicate findings to one per identity, keeping the first occurrence.
 * When two findings share a key but differ in validation strength, keep the
 * stronger evidence: a `validated` survivor should not be shadowed by a later
 * `pending`/`refuted` duplicate.
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = byKey.get(key);
    if (!existing || validationRank(finding) < validationRank(existing)) {
      byKey.set(key, finding);
    }
  }
  return [...byKey.values()];
}

/** Lower is stronger evidence — used only to pick the survivor among duplicates. */
function validationRank(finding: Finding): number {
  switch (finding.validation) {
    case "validated":
      return 0;
    case "refuted":
      return 1;
    case "indeterminate":
      return 2;
    case "pending":
      return 3;
    case "not_requested":
      return 4;
    case "failed":
      return 5;
    default: {
      const _exhaustive: never = finding.validation;
      return _exhaustive;
    }
  }
}
