import { describe, expect, it } from "vitest";
import { COMPLETE_COVERAGE, analysisFailed, coverageFrom } from "../evidence/coverage.js";
import {
  NightlyReport,
  NightlyReportFinding,
  NightlyWorkGraph,
  NightlyWorkItem,
  RemediationRecord,
  canTransitionCi,
  canTransitionDelivery,
  canTransitionMerge,
  canTransitionRemediation,
  canTransitionResolution,
  isCompleteReview,
  isSettledResolution,
  planNightlyWorkGraph,
  requiredCoverageGaps,
  summarizeReportFindings,
  type NightlyReportFinding as ReportFinding,
} from "./work-graph.js";
import { NIGHTLY_REPORT_SCHEMA_VERSION, deterministicFixerProvenance, type NightlyReportIdentity } from "./work-identity.js";

const IDENTITY: NightlyReportIdentity = {
  repository: "acme/web",
  branch: "main",
  baseSha: null,
  headSha: "b".repeat(40),
  policyVersion: "policy-v1",
  schemaVersion: NIGHTLY_REPORT_SCHEMA_VERSION,
};

function surfaced(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    occurrenceId: "nfo_surfaced",
    findingKey: JSON.stringify(["disabled-tls-verification", "TLS.X", "src/http.ts", 5, 5]),
    ruleId: "TLS.X",
    defectClass: "disabled-tls-verification",
    region: { path: "src/http.ts", startLine: 5, endLine: 5 },
    validation: "validated",
    deterministicSupport: true,
    visibility: "surfaced",
    visibilityReason: "reportable_validated",
    resolution: "open",
    remediation: { state: "pending", reason: "attempt_owed", proposal: null },
    ...overrides,
  };
}

function suppressed(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return surfaced({
    occurrenceId: "nfo_suppressed",
    findingKey: JSON.stringify(["disabled-tls-verification", "TLS.X", "test/http.test.ts", 1, 1]),
    region: { path: "test/http.test.ts", startLine: 1, endLine: 1 },
    validation: "refuted",
    visibility: "suppressed",
    visibilityReason: "refuted",
    remediation: null,
    ...overrides,
  });
}

function reportOf(findings: ReportFinding[], coverage = COMPLETE_COVERAGE): NightlyReport {
  const gaps = requiredCoverageGaps(coverage);
  return NightlyReport.parse({
    reportId: "nrp_test",
    identity: IDENTITY,
    coverage,
    requiredCoverageComplete: gaps.length === 0,
    findings,
    summary: summarizeReportFindings(findings, gaps.length),
  });
}

const PROPOSAL = {
  proposalId: "nfp_test",
  occurrenceId: "nfo_surfaced",
  provenance: deterministicFixerProvenance("disabled-tls-verification"),
  branch: "scruffy/fix/x",
  edits: [{ path: "src/http.ts", startLine: 5, endLine: 5, replacement: "safe", rationale: "revert the flag" }],
  readiness: "ready" as const,
  validationReason: "deterministic_patch_ready",
  delivery: "queued" as const,
  ci: "unknown" as const,
  merge: "open" as const,
};

describe("lifecycle transitions", () => {
  it("permits the legal resolution path and refuses to shortcut verification", () => {
    expect(canTransitionResolution("open", "awaiting_verification")).toEqual({ legal: true });
    expect(canTransitionResolution("awaiting_verification", "resolved")).toEqual({ legal: true });
    // A finding cannot go straight to resolved: something must be verified first.
    expect(canTransitionResolution("open", "resolved")).toEqual({ legal: false, reason: "illegal_transition" });
    // Indeterminate verification must be able to fall back to open, not resolve.
    expect(canTransitionResolution("awaiting_verification", "open")).toEqual({ legal: true });
  });

  it("treats resolved and dismissed as settled", () => {
    expect(isSettledResolution("resolved")).toBe(true);
    expect(isSettledResolution("dismissed")).toBe(true);
    expect(isSettledResolution("open")).toBe(false);
    expect(isSettledResolution("awaiting_verification")).toBe(false);
    expect(canTransitionResolution("resolved", "open")).toEqual({ legal: false, reason: "terminal_state" });
    expect(canTransitionResolution("dismissed", "resolved")).toEqual({ legal: false, reason: "terminal_state" });
  });

  it("permits a remediation attempt to progress and to be re-attempted, but never to skip to proposed", () => {
    expect(canTransitionRemediation("pending", "generating")).toEqual({ legal: true });
    expect(canTransitionRemediation("generating", "proposed")).toEqual({ legal: true });
    expect(canTransitionRemediation("pending", "proposed")).toEqual({ legal: false, reason: "illegal_transition" });
    expect(canTransitionRemediation("unavailable", "pending")).toEqual({ legal: true });
    expect(canTransitionRemediation("failed", "pending")).toEqual({ legal: true });
  });

  it("permits promoting a draft PR but never silently demoting a ready one", () => {
    expect(canTransitionDelivery("queued", "draft_open")).toEqual({ legal: true });
    expect(canTransitionDelivery("draft_open", "ready_open")).toEqual({ legal: true });
    expect(canTransitionDelivery("ready_open", "draft_open")).toEqual({ legal: false, reason: "terminal_state" });
    expect(canTransitionDelivery("delivery_failed", "queued")).toEqual({ legal: true });
  });

  it("lets CI change its mind but makes a merge final", () => {
    expect(canTransitionCi("passed", "failed")).toEqual({ legal: true });
    expect(canTransitionCi("failed", "passed")).toEqual({ legal: true });
    expect(canTransitionMerge("open", "merged")).toEqual({ legal: true });
    expect(canTransitionMerge("closed_unmerged", "open")).toEqual({ legal: true });
    expect(canTransitionMerge("merged", "open")).toEqual({ legal: false, reason: "terminal_state" });
    expect(canTransitionMerge("merged", "closed_unmerged")).toEqual({ legal: false, reason: "terminal_state" });
  });
});

describe("illegal states are unrepresentable", () => {
  it("rejects a remediation that claims 'proposed' with no proposal", () => {
    expect(() => RemediationRecord.parse({ state: "proposed", reason: "deterministic_patch_ready", proposal: null })).toThrow(
      /requires a proposal/,
    );
  });

  it("rejects a non-proposed remediation that carries a proposal", () => {
    expect(() => RemediationRecord.parse({ state: "pending", reason: "attempt_owed", proposal: PROPOSAL })).toThrow(
      /must not carry a proposal/,
    );
  });

  it("rejects a suppressed finding that owes remediation or walks a resolution lifecycle", () => {
    expect(() => NightlyReportFinding.parse(suppressed({ remediation: { state: "pending", reason: "attempt_owed", proposal: null } }))).toThrow(
      /owes no remediation/,
    );
    expect(() => NightlyReportFinding.parse(suppressed({ resolution: "dismissed" }))).toThrow(/no resolution lifecycle/);
  });

  it("rejects a surfaced finding with no remediation record", () => {
    expect(() => NightlyReportFinding.parse(surfaced({ remediation: null }))).toThrow(/owes a remediation record/);
  });

  it("rejects 'not_surfaced' as the reason for a surfaced finding", () => {
    expect(() =>
      NightlyReportFinding.parse(surfaced({ remediation: { state: "unavailable", reason: "not_surfaced", proposal: null } })),
    ).toThrow(/cannot explain a surfaced finding/);
  });

  it("refuses to record awaiting_verification without a merged proposal — a PR is not a fix", () => {
    const proposedButOpen = surfaced({
      resolution: "awaiting_verification",
      remediation: { state: "proposed", reason: "deterministic_patch_ready", proposal: PROPOSAL },
    });
    expect(() => NightlyReportFinding.parse(proposedButOpen)).toThrow(/requires a merged proposal/);

    const merged = surfaced({
      resolution: "awaiting_verification",
      remediation: {
        state: "proposed",
        reason: "deterministic_patch_ready",
        proposal: { ...PROPOSAL, delivery: "ready_open", ci: "passed", merge: "merged" },
      },
    });
    expect(NightlyReportFinding.parse(merged).resolution).toBe("awaiting_verification");
  });

  it("rejects a report whose completeness or summary disagrees with its own contents", () => {
    const gapped = coverageFrom([{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "down" }]);
    expect(() =>
      NightlyReport.parse({
        reportId: "nrp_test",
        identity: IDENTITY,
        coverage: gapped,
        requiredCoverageComplete: true, // the lie this schema exists to catch
        findings: [],
        summary: { surfaced: 0, suppressed: 0, proposals: 0, requiredGaps: 1 },
      }),
    ).toThrow(/must agree with the coverage gaps/);

    expect(() =>
      NightlyReport.parse({
        reportId: "nrp_test",
        identity: IDENTITY,
        coverage: COMPLETE_COVERAGE,
        requiredCoverageComplete: true,
        findings: [surfaced()],
        summary: { surfaced: 0, suppressed: 0, proposals: 0, requiredGaps: 0 },
      }),
    ).toThrow(/summary must agree/);
  });

  it("rejects a report carrying the same occurrence twice", () => {
    const twice = [surfaced(), surfaced()];
    expect(() =>
      NightlyReport.parse({
        reportId: "nrp_test",
        identity: IDENTITY,
        coverage: COMPLETE_COVERAGE,
        requiredCoverageComplete: true,
        findings: twice,
        summary: summarizeReportFindings(twice, 0),
      }),
    ).toThrow(/deduplicated by occurrence id/);
  });

  it("rejects a work graph with orphaned or misattached children", () => {
    const graph = planNightlyWorkGraph(reportOf([surfaced()]));
    expect(() => NightlyWorkGraph.parse({ parent: null, children: graph.children })).toThrow(/children require a parent/);
    expect(() =>
      NightlyWorkGraph.parse({ parent: graph.parent, children: [{ ...graph.children[0]!, parentWorkItemId: "nwi_run_other" }] }),
    ).toThrow(/must attach to this report's parent/);
    expect(() => NightlyWorkGraph.parse({ parent: graph.parent, children: [graph.children[0]!, graph.children[0]!] })).toThrow(
      /duplicate child work item/,
    );
  });

  it("rejects a work item whose kind disagrees with its own occurrence/coverage-gap fields", () => {
    const graph = planNightlyWorkGraph(reportOf([surfaced()]));
    const parent = graph.parent!;
    const findingChild = graph.children[0]!;

    // A parent must carry no occurrence, coverage gap, or parent link of its own.
    expect(() => NightlyWorkItem.parse({ ...parent, occurrenceId: "nfo_surfaced" })).toThrow(/must have no parent, occurrence/);
    // A 'finding' item must carry an occurrence id and no coverage gap.
    expect(() => NightlyWorkItem.parse({ ...findingChild, occurrenceId: null })).toThrow(/must have a parent and an occurrence id/);
    expect(() =>
      NightlyWorkItem.parse({ ...findingChild, coverageGap: { analyzerId: "a", code: "provider_unavailable" } }),
    ).toThrow(/must not carry a coverage gap/);
    // A 'coverage_gap' item must carry a coverage gap and no occurrence id.
    const gapGraph = planNightlyWorkGraph(reportOf([], analysisFailed("model backend unreachable")));
    const gapChild = gapGraph.children[0]!;
    expect(() => NightlyWorkItem.parse({ ...gapChild, coverageGap: null })).toThrow(/must have a parent and a coverage gap/);
    expect(() => NightlyWorkItem.parse({ ...gapChild, occurrenceId: "nfo_surfaced" })).toThrow(/must not carry an occurrence id/);
  });
});

describe("coverage completeness", () => {
  it("treats every current gap code as holding the complete-review watermark", () => {
    for (const code of ["provider_unavailable", "unparseable_output", "input_truncated", "output_capped"] as const) {
      const report = reportOf([], coverageFrom([{ analyzerId: "a", code, detail: "" }]));
      expect(isCompleteReview(report)).toBe(false);
    }
    expect(isCompleteReview(reportOf([]))).toBe(true);
  });

  it("orders gaps deterministically so replays produce identical work items", () => {
    const gaps = requiredCoverageGaps(
      coverageFrom([
        { analyzerId: "zeta", code: "provider_unavailable", detail: "" },
        { analyzerId: "alpha", code: "unparseable_output", detail: "" },
        { analyzerId: "alpha", code: "input_truncated", detail: "" },
      ]),
    );
    expect(gaps.map((g) => `${g.analyzerId}:${g.code}`)).toEqual([
      "alpha:input_truncated",
      "alpha:unparseable_output",
      "zeta:provider_unavailable",
    ]);
  });
});

describe("planNightlyWorkGraph", () => {
  it("creates NO work at all for a complete run with nothing surfaced", () => {
    const graph = planNightlyWorkGraph(reportOf([suppressed()]));
    expect(graph).toEqual({ parent: null, children: [] });
  });

  it("creates exactly one parent and one child per surfaced finding", () => {
    const other = surfaced({
      occurrenceId: "nfo_other",
      findingKey: JSON.stringify(["leaked-credential", "SECRET.AWS", "src/config.ts", 1, 1]),
      ruleId: "SECRET.AWS",
      defectClass: "leaked-credential",
      region: { path: "src/config.ts", startLine: 1, endLine: 1 },
    });
    const graph = planNightlyWorkGraph(reportOf([surfaced(), other, suppressed()]));

    expect(graph.parent).not.toBeNull();
    expect(graph.children).toHaveLength(2);
    expect(graph.children.every((c) => c.kind === "finding")).toBe(true);
    expect(graph.children.map((c) => c.occurrenceId)).toEqual(["nfo_surfaced", "nfo_other"]);
    // The suppressed finding stays in the audit record and nowhere else.
    expect(graph.children.some((c) => c.occurrenceId === "nfo_suppressed")).toBe(false);
    expect(NightlyWorkGraph.parse(graph).children).toHaveLength(2);
  });

  it("creates a parent and a coverage child even when NOTHING was found", () => {
    const graph = planNightlyWorkGraph(reportOf([], analysisFailed("model backend unreachable")));
    expect(graph.parent?.kind).toBe("nightly_run");
    expect(graph.parent?.title).toMatch(/1 coverage gap/);
    expect(graph.parent?.body).toMatch(/not a clean bill of health/);
    expect(graph.children).toHaveLength(1);
    expect(graph.children[0]!.kind).toBe("coverage_gap");
    expect(graph.children[0]!.coverageGap).toEqual({ analyzerId: "analysis", code: "provider_unavailable" });
    expect(graph.children[0]!.body).toMatch(/model backend unreachable/);
  });

  it("says out loud that a merge does not close a finding child", () => {
    const graph = planNightlyWorkGraph(reportOf([surfaced()]));
    expect(graph.children[0]!.body).toMatch(/does not close this item/);
  });

  it("is deterministic: the same report yields byte-identical work items", () => {
    const report = reportOf([surfaced()], coverageFrom([{ analyzerId: "m", code: "provider_unavailable", detail: "x" }]));
    expect(planNightlyWorkGraph(report)).toEqual(planNightlyWorkGraph(report));
  });

  it("collapses two gaps from the same analyzer and code into one child", () => {
    const coverage = coverageFrom([
      { analyzerId: "model-analyzer", code: "provider_unavailable", detail: "attempt 1" },
      { analyzerId: "model-analyzer", code: "provider_unavailable", detail: "attempt 2" },
    ]);
    const graph = planNightlyWorkGraph(reportOf([], coverage));
    expect(graph.children).toHaveLength(1);
  });
});
