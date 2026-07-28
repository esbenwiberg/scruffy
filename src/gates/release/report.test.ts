import { describe, expect, it } from "vitest";
import {
  assembleReleaseReport,
  computeReportId,
  parseReleaseReport,
  ReleaseRiskReport,
  type AssembleReleaseReportInput,
  type ReleaseReportContent,
} from "../../domain/release/report.js";
import type { ReleaseDecision } from "./decision.js";
import { COMPLETE_COVERAGE } from "../../domain/evidence/coverage.js";
import type { Finding } from "../../domain/evidence/types.js";

/**
 * Report identity is the load-bearing contract of this slice: the reportId must be
 * content-bound (base, candidate, policy, report version, evidence, decision) and
 * MUST NOT depend on the volatile generatedAt stamp or on object key insertion
 * order. A constant or candidate-only id — the obvious broken implementation — is
 * rejected here.
 */

const REPO = "acme/web";
const PREV = "a1".repeat(20);
const CAND = "b2".repeat(20);
const OTHER = "c3".repeat(20);

const SHIP: ReleaseDecision = {
  outcome: "ship",
  reasons: ["no_release_findings"],
  dispositions: [],
  summary: { stopped: 0, escalated: 0, cleared: 0, notRelevant: 0 },
  coverage: COMPLETE_COVERAGE,
};

const STOP: ReleaseDecision = {
  outcome: "stop",
  reasons: ["stop_class_confirmed"],
  dispositions: [
    {
      ruleId: "secret-scan/aws",
      defectClass: "leaked-credential",
      region: { path: "src/config.ts", startLine: 1 },
      effect: "stops",
      reason: "stop_class_confirmed",
      deterministicSupport: true,
    },
  ],
  summary: { stopped: 1, escalated: 0, cleared: 0, notRelevant: 0 },
  coverage: COMPLETE_COVERAGE,
};

const FINDING: Finding = {
  ruleId: "secret-scan/aws",
  defectClass: "leaked-credential",
  subject: { repository: REPO, commitSha: CAND },
  primaryRegion: { path: "src/config.ts", startLine: 1, endLine: 1, snippet: "AKIA..." },
  provenance: { analyzerId: "secret-scan", analyzerVersion: "1", modelId: null, promptVersion: null },
  supporting: [{ trust: "deterministic", statement: "matches AWS key shape" }],
  contradicting: [],
  completeness: { requiredEvidencePresent: true, contextTruncated: false },
  validation: "validated",
};

function baseInput(over: Partial<AssembleReleaseReportInput> = {}): AssembleReleaseReportInput {
  return {
    subject: { repository: REPO, previousReleaseSha: PREV, candidateSha: CAND },
    policyVersion: "policy-v1",
    generatedAt: "2026-07-15T00:00:00.000Z",
    provenance: { analyzers: [{ id: "secret-scan" }, { id: "disabled-tls" }] },
    findings: [],
    decision: SHIP,
    ...over,
  };
}

describe("release report", () => {
  it("release report identity and SHA binding", () => {
    const idOf = (over: Partial<AssembleReleaseReportInput> = {}): string => assembleReleaseReport(baseInput(over)).reportId;
    const base = idOf();

    // Not a constant / candidate-only id: the SUBJECT bindings all move it.
    expect(idOf({ subject: { repository: REPO, previousReleaseSha: OTHER, candidateSha: CAND } })).not.toBe(base); // base sha
    expect(idOf({ subject: { repository: REPO, previousReleaseSha: PREV, candidateSha: OTHER } })).not.toBe(base); // candidate sha
    expect(idOf({ subject: { repository: "acme/other", previousReleaseSha: PREV, candidateSha: CAND } })).not.toBe(base); // repository
    expect(idOf({ policyVersion: "policy-v2" })).not.toBe(base); // policy version

    // Evidence content moves it: a different findings set is different evidence.
    expect(idOf({ findings: [FINDING] })).not.toBe(base);

    // Decision content moves it.
    expect(idOf({ decision: STOP })).not.toBe(base);

    // Volatile generatedAt does NOT move it.
    expect(idOf({ generatedAt: "2030-01-01T12:34:56.000Z" })).toBe(base);
  });

  it("is independent of object key insertion order", () => {
    // Two contents with identical values but different key insertion order (nested
    // too) must hash to the same identity — equivalent committed content, one id.
    const content: ReleaseReportContent = {
      reportVersion: "1",
      subject: { repository: REPO, previousReleaseSha: PREV, candidateSha: CAND },
      policyVersion: "policy-v1",
      provenance: { analyzers: [{ id: "secret-scan" }] },
      changeSummary: "",
      evidenceLanes: [
        {
          laneId: "source-analysis",
          required: true,
          applicable: true,
          status: "complete",
          subjectSha: CAND,
          provenance: [{ id: "secret-scan" }],
          observations: ["ok"],
          gaps: [],
        },
      ],
      risks: [],
      findings: [],
      decision: SHIP,
    };
    const reordered: ReleaseReportContent = {
      decision: SHIP,
      findings: [],
      risks: [],
      evidenceLanes: [
        {
          gaps: [],
          observations: ["ok"],
          provenance: [{ id: "secret-scan" }],
          subjectSha: CAND,
          status: "complete",
          applicable: true,
          required: true,
          laneId: "source-analysis",
        },
      ],
      changeSummary: "",
      provenance: { analyzers: [{ id: "secret-scan" }] },
      policyVersion: "policy-v1",
      subject: { candidateSha: CAND, previousReleaseSha: PREV, repository: REPO },
      reportVersion: "1",
    };
    expect(computeReportId(content)).toBe(computeReportId(reordered));
  });

  it("assembles a schema-valid report with a single source-analysis lane", () => {
    const report = assembleReleaseReport(baseInput());
    // Round-trips through the read-boundary parser (never trust the blob).
    const parsed = parseReleaseReport(JSON.parse(JSON.stringify(report)));
    expect(() => ReleaseRiskReport.parse(parsed)).not.toThrow();

    expect(parsed.reportVersion).toBe("1");
    expect(parsed.reportId).toBe(report.reportId);
    expect(parsed.subject).toEqual({ repository: REPO, previousReleaseSha: PREV, candidateSha: CAND });
    expect(parsed.evidenceLanes).toHaveLength(1);
    expect(parsed.evidenceLanes[0]!.laneId).toBe("source-analysis");
    expect(parsed.evidenceLanes[0]!.status).toBe("complete");
    expect(parsed.evidenceLanes[0]!.subjectSha).toBe(CAND);
    expect(parsed.risks).toEqual([]);
    expect(parsed.changeSummary).toBe("");
    expect(parsed.decision.outcome).toBe("ship");
  });
});
