import type { ReleaseRiskReport } from "./report.js";

/**
 * Deterministic exception-acceptance language. An LLM may describe risk, but it
 * never authors or weakens the human responsibility boundary.
 */
export function signoffResponsibility(
  report: Pick<ReleaseRiskReport, "reportId" | "subject">,
): string {
  return (
    `By approving this exception, you personally accept responsibility for releasing candidate ` +
    `${report.subject.candidateSha} despite the unresolved risks and evidence gaps recorded in report ${report.reportId}. ` +
    `Scruffy has not certified this release as safe. This approval applies only to this exact candidate and report.`
  );
}
