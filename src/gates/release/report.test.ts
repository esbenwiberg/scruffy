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
import { unavailableOutstandingWork } from "../../domain/release/outstanding-work.js";
import { buildPrerequisiteSnapshot } from "../../domain/release/prerequisite-snapshot.js";
import type { ReleaseAuthorityAssessment } from "../../domain/release/authority-change.js";
import type {
  RequiredWorkflowAggregate,
  RequiredWorkflowEvidence,
} from "../../domain/release/required-workflow-evidence.js";

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
const ARTIFACT = `sha256:${"d4".repeat(32)}`;
const ENVIRONMENT = "shadow-production";

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
  provenance: {
    analyzerId: "secret-scan",
    analyzerVersion: "1",
    modelId: null,
    promptVersion: null,
  },
  supporting: [{ trust: "deterministic", statement: "matches AWS key shape" }],
  contradicting: [],
  completeness: { requiredEvidencePresent: true, contextTruncated: false },
  validation: "validated",
};

function baseInput(over: Partial<AssembleReleaseReportInput> = {}): AssembleReleaseReportInput {
  return {
    subject: {
      repository: REPO,
      previousReleaseSha: PREV,
      candidateSha: CAND,
      artifactDigest: ARTIFACT,
      targetEnvironment: ENVIRONMENT,
    },
    policyVersion: "policy-v1",
    generatedAt: "2026-07-15T00:00:00.000Z",
    provenance: { analyzers: [{ id: "secret-scan" }, { id: "disabled-tls" }] },
    findings: [],
    decision: SHIP,
    ...over,
  };
}

describe("release report", () => {
  it("release envelope identity", () => {
    const idOf = (over: Partial<AssembleReleaseReportInput> = {}): string =>
      assembleReleaseReport(baseInput(over)).reportId;
    const base = idOf();

    // Not a constant / candidate-only id: the SUBJECT bindings all move it.
    expect(idOf({ subject: { ...baseInput().subject, previousReleaseSha: OTHER } })).not.toBe(base); // base sha
    expect(idOf({ subject: { ...baseInput().subject, candidateSha: OTHER } })).not.toBe(base); // candidate sha
    expect(idOf({ subject: { ...baseInput().subject, repository: "acme/other" } })).not.toBe(base); // repository
    expect(
      idOf({ subject: { ...baseInput().subject, artifactDigest: `sha256:${"e5".repeat(32)}` } }),
    ).not.toBe(base);
    expect(
      idOf({ subject: { ...baseInput().subject, targetEnvironment: "another-environment" } }),
    ).not.toBe(base);
    expect(idOf({ policyVersion: "policy-v2" })).not.toBe(base); // policy version

    // Evidence content moves it: a different findings set is different evidence.
    expect(idOf({ findings: [FINDING] })).not.toBe(base);

    // Decision content moves it.
    expect(idOf({ decision: STOP })).not.toBe(base);

    // Context is not decision authority, but it is evidence displayed to the
    // signer and therefore remains content-bound to the report identity.
    expect(idOf({ outstandingWork: unavailableOutstandingWork("context unavailable") })).not.toBe(
      base,
    );

    // Volatile generatedAt does NOT move it.
    expect(idOf({ generatedAt: "2030-01-01T12:34:56.000Z" })).toBe(base);

    expect(() =>
      assembleReleaseReport(
        baseInput({ subject: { ...baseInput().subject, artifactDigest: "sha256:not-a-digest" } }),
      ),
    ).toThrow();
    expect(() =>
      assembleReleaseReport(
        baseInput({ subject: { ...baseInput().subject, targetEnvironment: "bad environment" } }),
      ),
    ).toThrow();
  });

  it("is independent of object key insertion order", () => {
    // Two contents with identical values but different key insertion order (nested
    // too) must hash to the same identity — equivalent committed content, one id.
    const content: ReleaseReportContent = {
      reportVersion: "2",
      subject: {
        repository: REPO,
        previousReleaseSha: PREV,
        candidateSha: CAND,
        artifactDigest: ARTIFACT,
        targetEnvironment: ENVIRONMENT,
      },
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
      subject: {
        targetEnvironment: ENVIRONMENT,
        artifactDigest: ARTIFACT,
        candidateSha: CAND,
        previousReleaseSha: PREV,
        repository: REPO,
      },
      reportVersion: "2",
    };
    expect(computeReportId(content)).toBe(computeReportId(reordered));
  });

  it("appends a release-risk-llm lane and carries model risks when an analyst is wired", () => {
    const report = assembleReleaseReport(
      baseInput({
        releaseRisk: {
          changeSummary: "adjusts pricing across two files",
          risks: [
            {
              category: "cross-change-interaction",
              scenario: "rate and its consumer diverge",
              affectedSurface: "pricing",
              blastRadius: "all invoices produced during the rollout",
              impact: "wrong charges",
              detectability: "invoice reconciliation",
              reversibility: "new invoices recover; issued invoices need correction",
              rollback: "restore the prior rate and reconcile invoices",
              uncertainty: "production invoice volume is unknown",
              supportingEvidence: ["rate and consumer changed together"],
              contradictingEvidence: [],
              citations: [
                { path: "src/rate.ts", line: 1 },
                { path: "src/invoice.ts", line: 2 },
              ],
            },
          ],
          gaps: [],
          reviewedLines: 3,
          totalLines: 3,
          analyzer: { id: "release-risk-analyst", version: "1.1.0" },
          modelId: "fake-model",
          promptVersion: "release-risk-v2",
        },
      }),
    );

    // Both lanes present, coverage-first order preserved (source, then llm).
    expect(report.evidenceLanes.map((l) => l.laneId)).toEqual([
      "source-analysis",
      "release-risk-llm",
    ]);
    const llm = report.evidenceLanes.find((l) => l.laneId === "release-risk-llm")!;
    expect(llm.status).toBe("complete");
    expect(llm.subjectSha).toBe(CAND);

    // The model's evidence is carried into the report boundary.
    expect(report.changeSummary).toBe("adjusts pricing across two files");
    expect(report.risks).toHaveLength(1);
    expect(report.risks[0]!.category).toBe("cross-change-interaction");
    expect(report.risks[0]!.blastRadius).toContain("all invoices");
    expect(report.provenance.modelId).toBe("fake-model");
    expect(report.provenance.promptVersion).toBe("release-risk-v2");

    // Round-trips through the read boundary unchanged.
    expect(() => parseReleaseReport(JSON.parse(JSON.stringify(report)))).not.toThrow();
  });

  it("marks the release-risk-llm lane failed when nothing was reviewed", () => {
    const report = assembleReleaseReport(
      baseInput({
        releaseRisk: {
          changeSummary: "",
          risks: [],
          gaps: [{ code: "provider_unavailable", detail: "provider down" }],
          reviewedLines: 0,
          totalLines: 5,
          analyzer: { id: "release-risk-analyst", version: "1.1.0" },
          promptVersion: "release-risk-v2",
        },
      }),
    );
    const llm = report.evidenceLanes.find((l) => l.laneId === "release-risk-llm")!;
    expect(llm.status).toBe("failed");
    expect(llm.gaps).toEqual(["provider_unavailable: provider down"]);
    // No model reached → no modelId recorded, but the prompt version still is.
    expect(report.provenance.modelId).toBeUndefined();
    expect(report.provenance.promptVersion).toBe("release-risk-v2");
  });

  // --- Workflow-prerequisite report identity ------------------------------------
  //
  // A v3 report binds the WHOLE prerequisite snapshot — repository configuration
  // identity, the authority baseline/change facts, and every exact workflow run
  // attempt — into its content id. Any of those moving must move the reportId; an
  // exact replay (only generatedAt differing) must not. This is the durable
  // contract the successor/freshness rules downstream depend on.
  const CFG_A = { version: 1 as const, requiredWorkflows: [".github/workflows/ci.yml"] };

  function authority(over: Partial<ReleaseAuthorityAssessment> = {}): ReleaseAuthorityAssessment {
    return {
      outcome: "clean",
      reasonCode: "authority_unchanged",
      firstAdoption: false,
      configChanged: false,
      changedAuthorityPaths: [],
      addedRequiredWorkflows: [],
      removedRequiredWorkflows: [],
      candidate: { config: CFG_A, digest: "cfg-digest-a" },
      previous: { config: CFG_A, digest: "cfg-digest-a" },
      detail: "release authority unchanged since the previous baseline",
      ...over,
    };
  }

  function evidence(over: Partial<RequiredWorkflowEvidence> = {}): RequiredWorkflowEvidence {
    return {
      workflowId: 7,
      workflowPath: ".github/workflows/ci.yml",
      runId: 100,
      runAttempt: 1,
      event: "push",
      branch: "main",
      candidateSha: CAND,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/web/actions/runs/100",
      ...over,
    };
  }

  function aggregate(over: Partial<RequiredWorkflowAggregate> = {}): RequiredWorkflowAggregate {
    return {
      outcome: "satisfied",
      reasonCode: "required_workflows_satisfied",
      workflows: [{ workflowPath: ".github/workflows/ci.yml", state: "passed", evidence: evidence() }],
      ...over,
    };
  }

  const prereqId = (auth: ReleaseAuthorityAssessment, agg: RequiredWorkflowAggregate): string =>
    assembleReleaseReport(baseInput({ prerequisite: buildPrerequisiteSnapshot(auth, agg) })).reportId;

  it("workflow prerequisite report identity", () => {
    const base = prereqId(authority(), aggregate());

    // A v3 report actually carries the snapshot at schema version 3.
    const report = assembleReleaseReport(
      baseInput({ prerequisite: buildPrerequisiteSnapshot(authority(), aggregate()) }),
    );
    expect(report.reportVersion).toBe("3");
    expect(report.prerequisite?.evidenceDigest).toMatch(/^pe_[0-9a-f]{64}$/);
    // Round-trips through the untrusted read boundary unchanged.
    expect(() => parseReleaseReport(JSON.parse(JSON.stringify(report)))).not.toThrow();

    // Exact replay (only the volatile generatedAt differs) keeps the same id.
    expect(
      assembleReleaseReport(
        baseInput({
          prerequisite: buildPrerequisiteSnapshot(authority(), aggregate()),
          generatedAt: "2031-05-05T05:05:05.000Z",
        }),
      ).reportId,
    ).toBe(base);

    // --- Repository configuration identity moves it.
    expect(prereqId(authority({ candidate: { config: CFG_A, digest: "cfg-digest-b" } }), aggregate())).not.toBe(base);
    expect(
      prereqId(
        authority({
          candidate: {
            config: { version: 1, requiredWorkflows: [".github/workflows/ci.yml", ".github/workflows/int.yml"] },
            digest: "cfg-digest-a",
          },
        }),
        aggregate(),
      ),
    ).not.toBe(base);
    // Previous-baseline configuration is part of the authority comparison identity.
    expect(prereqId(authority({ previous: { config: CFG_A, digest: "cfg-digest-prev" } }), aggregate())).not.toBe(base);

    // --- Authority / baseline / change facts move it.
    expect(prereqId(authority({ outcome: "sign-off-required", reasonCode: "release_authority_changed" }), aggregate())).not.toBe(base);
    expect(prereqId(authority({ firstAdoption: true }), aggregate())).not.toBe(base);
    expect(prereqId(authority({ configChanged: true }), aggregate())).not.toBe(base);
    expect(prereqId(authority({ changedAuthorityPaths: [".github/workflows/ci.yml"] }), aggregate())).not.toBe(base);
    expect(prereqId(authority({ addedRequiredWorkflows: [".github/workflows/int.yml"] }), aggregate())).not.toBe(base);
    expect(prereqId(authority({ removedRequiredWorkflows: [".github/workflows/old.yml"] }), aggregate())).not.toBe(base);

    // --- Exact workflow identity / run / attempt / status / conclusion move it.
    const withEvidence = (over: Partial<RequiredWorkflowEvidence>): string =>
      prereqId(
        authority(),
        aggregate({
          workflows: [{ workflowPath: ".github/workflows/ci.yml", state: "passed", evidence: evidence(over) }],
        }),
      );
    expect(withEvidence({ workflowId: 999 })).not.toBe(base); // workflow identity, never a display name
    expect(withEvidence({ workflowPath: ".github/workflows/other.yml" })).not.toBe(base);
    expect(withEvidence({ runId: 200 })).not.toBe(base);
    expect(withEvidence({ runAttempt: 2 })).not.toBe(base); // a rerun's attempt
    expect(withEvidence({ status: "queued" })).not.toBe(base);
    expect(withEvidence({ conclusion: "failure" })).not.toBe(base);
    expect(withEvidence({ event: "workflow_dispatch" })).not.toBe(base);
    expect(withEvidence({ branch: "release" })).not.toBe(base);

    // --- Classified per-workflow state and the aggregate state move it.
    expect(
      prereqId(
        authority(),
        aggregate({
          outcome: "exception-eligible",
          reasonCode: "required_workflow_failed",
          workflows: [
            {
              workflowPath: ".github/workflows/ci.yml",
              state: "terminal-failed",
              evidence: evidence({ conclusion: "failure" }),
            },
          ],
        }),
      ),
    ).not.toBe(base);
    expect(prereqId(authority(), aggregate({ outcome: "not-ready", reasonCode: "required_workflow_pending" }))).not.toBe(base);

    // A v2 report (no prerequisite) is a different identity again — the snapshot is
    // genuinely part of the content, not a no-op field.
    expect(assembleReleaseReport(baseInput()).reportId).not.toBe(base);
  });

  it("assembles a schema-valid report with a single source-analysis lane", () => {
    const report = assembleReleaseReport(baseInput());
    // Round-trips through the read-boundary parser (never trust the blob).
    const parsed = parseReleaseReport(JSON.parse(JSON.stringify(report)));
    expect(() => ReleaseRiskReport.parse(parsed)).not.toThrow();

    expect(parsed.reportVersion).toBe("2");
    expect(parsed.reportId).toBe(report.reportId);
    expect(parsed.subject).toEqual({
      repository: REPO,
      previousReleaseSha: PREV,
      candidateSha: CAND,
      artifactDigest: ARTIFACT,
      targetEnvironment: ENVIRONMENT,
    });
    expect(parsed.evidenceLanes).toHaveLength(1);
    expect(parsed.evidenceLanes[0]!.laneId).toBe("source-analysis");
    expect(parsed.evidenceLanes[0]!.status).toBe("complete");
    expect(parsed.evidenceLanes[0]!.subjectSha).toBe(CAND);
    expect(parsed.risks).toEqual([]);
    expect(parsed.changeSummary).toBe("");
    expect(parsed.decision.outcome).toBe("ship");
  });
});
