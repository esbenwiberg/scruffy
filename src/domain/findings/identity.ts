import type { EvidenceItem, Finding } from "../evidence/types.js";

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
 * Components are JSON-encoded as an array so the key is unambiguous even if a
 * path contains whitespace (a space-join would alias `"a b" 1` with `"a" "b 1"`).
 */
export function findingKey(finding: Finding): string {
  const { path, startLine, endLine } = finding.primaryRegion;
  return JSON.stringify([finding.defectClass, finding.ruleId, path, startLine, endLine]);
}

/**
 * Collapse duplicate findings to one per identity, MERGING their evidence.
 *
 * Picking a survivor and discarding the rest is the tempting implementation and
 * it is unsafe: two analyzers can reach the same identity with different
 * evidence, and if the discarded one held the `deterministic` statement, dedupe
 * would quietly demote a blockable finding to model-asserted. Silently losing
 * detection strength inside a helper called "dedupe" is exactly the kind of
 * invisible failure this codebase is built to avoid — so evidence is unioned and
 * only the scalar fields come from one representative.
 *
 * That representative is the strongest-validated duplicate, so a `validated`
 * finding is never shadowed by a later `pending`/`refuted` one.
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = byKey.get(key);
    byKey.set(key, existing ? merge(existing, finding) : finding);
  }
  return [...byKey.values()];
}

/** Fold two findings of the same identity into one that loses no evidence. */
function merge(a: Finding, b: Finding): Finding {
  const representative = validationRank(a) <= validationRank(b) ? a : b;
  return {
    ...representative,
    // Union in input order, so the result does not depend on which side won.
    supporting: unionEvidence(a.supporting, b.supporting),
    contradicting: unionEvidence(a.contradicting, b.contradicting),
    completeness: {
      // The merged finding carries the union of both observations, so if either
      // side had what its defect class requires, the merged one does too.
      requiredEvidencePresent: a.completeness.requiredEvidencePresent || b.completeness.requiredEvidencePresent,
      // Truncation is sticky the other way: if either view was partial, say so.
      contextTruncated: a.completeness.contextTruncated || b.completeness.contextTruncated,
    },
  };
}

function unionEvidence(a: readonly EvidenceItem[], b: readonly EvidenceItem[]): EvidenceItem[] {
  const byIdentity = new Map<string, EvidenceItem>();
  // JSON-encoded pair, like findingKey: a raw concatenation would let a crafted
  // statement collide with a different (trust, statement) pair.
  for (const item of [...a, ...b]) byIdentity.set(JSON.stringify([item.trust, item.statement]), item);
  return [...byIdentity.values()];
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
