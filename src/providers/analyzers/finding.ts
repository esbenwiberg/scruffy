import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";

/**
 * Builder for a deterministic-analyzer finding. Every line-pattern analyzer
 * emits the same shape: a single primary region, one deterministic supporting
 * item, complete evidence, validation still `pending`.
 *
 * The snippet is stored VERBATIM (including leading indentation). A fixer emits a
 * whole-line replacement for `[startLine, endLine]`, so a trimmed snippet would
 * produce a de-indented replacement — an IndentationError in Python, a broken
 * diff elsewhere. "The exact quoted text" (CodeRegion) is load-bearing, not
 * cosmetic.
 */
export function deterministicFinding(params: {
  ruleId: string;
  defectClass: string;
  subject: SubjectRevision;
  path: string;
  line: number;
  snippet: string;
  analyzerId: string;
  analyzerVersion: string;
  statement: string;
}): Finding {
  return {
    ruleId: params.ruleId,
    defectClass: params.defectClass,
    subject: params.subject,
    primaryRegion: { path: params.path, startLine: params.line, endLine: params.line, snippet: params.snippet },
    provenance: {
      analyzerId: params.analyzerId,
      analyzerVersion: params.analyzerVersion,
      modelId: null,
      promptVersion: null,
    },
    supporting: [{ trust: "deterministic", statement: params.statement }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "pending",
  };
}
