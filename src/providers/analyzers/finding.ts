import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";

/**
 * Builder for a deterministic-analyzer finding. Every line-pattern analyzer
 * emits the same shape: a single primary region, one deterministic supporting
 * item, complete evidence, validation still `pending`.
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
    primaryRegion: { path: params.path, startLine: params.line, endLine: params.line, snippet: params.snippet.trim() },
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
