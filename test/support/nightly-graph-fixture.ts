import type { Finding } from "../../src/domain/evidence/types.js";
import { COMPLETE_COVERAGE, coverageFrom } from "../../src/domain/evidence/coverage.js";
import type { NightlyPolicy } from "../../src/domain/policy/types.js";
import { dedupeFindings } from "../../src/domain/findings/identity.js";
import { planNightlyWorkGraph, type NightlyReport, type NightlyWorkGraph } from "../../src/domain/findings/work-graph.js";
import { NIGHTLY_REPORT_SCHEMA_VERSION, type NightlyReportIdentity } from "../../src/domain/findings/work-identity.js";
import { evaluateNightly } from "../../src/gates/nightly/decision.js";
import { generateFixes } from "../../src/gates/nightly/fix.js";
import { buildNightlyReport } from "../../src/gates/nightly/report.js";

/**
 * Report/work-graph fixtures built by the REAL kernel, report builder, and planner
 * rather than hand-written literals. A hand-written report can drift from the
 * schemas it is meant to exercise; running the production path means these fixtures
 * are wrong only if the product is.
 */

export const FIXTURE_REPO = "acme/web";
export const FIXTURE_BRANCH = "main";
export const FIXTURE_HEAD = "b".repeat(40);

export const FIXTURE_IDENTITY: NightlyReportIdentity = {
  repository: FIXTURE_REPO,
  branch: FIXTURE_BRANCH,
  baseSha: null,
  headSha: FIXTURE_HEAD,
  policyVersion: "policy-v1",
  schemaVersion: NIGHTLY_REPORT_SCHEMA_VERSION,
};

const POLICY: NightlyPolicy = {
  reportableDefectClasses: ["leaked-credential"],
  fixableDefectClasses: [],
};

function leakedCredential(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "SECRET.AWS_ACCESS_KEY_ID",
    defectClass: "leaked-credential",
    subject: { repository: FIXTURE_REPO, commitSha: FIXTURE_HEAD },
    primaryRegion: { path: "src/config.ts", startLine: 1, endLine: 1, snippet: "redacted" },
    provenance: { analyzerId: "secret-scan", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "matches an access-key pattern" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

function build(findings: Finding[], coverage = COMPLETE_COVERAGE): { report: NightlyReport; workGraph: NightlyWorkGraph } {
  const deduped = dedupeFindings(findings);
  const { decision, fixes } = generateFixes(deduped, evaluateNightly(deduped, POLICY, coverage), {});
  const report = buildNightlyReport({ identity: FIXTURE_IDENTITY, findings: deduped, decision, fixes });
  return { report, workGraph: planNightlyWorkGraph(report) };
}

/** One surfaced finding plus one required coverage gap: parent + two children. */
export function reportWithFindingAndCoverageGap(): { report: NightlyReport; workGraph: NightlyWorkGraph } {
  return build(
    [leakedCredential()],
    coverageFrom([{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "backend returned 503" }]),
  );
}

/** Complete coverage, nothing surfaced: no parent, no children, no issues. */
export function cleanCompleteReport(): { report: NightlyReport; workGraph: NightlyWorkGraph } {
  return build([]);
}

/**
 * Complete coverage with a REFUTED finding only. It stays in the audit record and
 * must produce no human-visible work at all.
 */
export function suppressedOnlyReport(): { report: NightlyReport; workGraph: NightlyWorkGraph } {
  return build([leakedCredential({ validation: "refuted" })]);
}
