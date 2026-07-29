import { describe, expect, it } from "vitest";
import type { Finding } from "../../domain/evidence/types.js";
import { COMPLETE_COVERAGE, analysisFailed, coverageFrom } from "../../domain/evidence/coverage.js";
import type { NightlyPolicy } from "../../domain/policy/types.js";
import { findingOccurrenceId, NIGHTLY_REPORT_SCHEMA_VERSION, type NightlyReportIdentity } from "../../domain/findings/work-identity.js";
import { findingKey } from "../../domain/findings/identity.js";
import { TlsFixer } from "../../providers/fixers/tls-fixer.js";
import { evaluateNightly } from "./decision.js";
import { generateFixes } from "./fix.js";
import { abstainedNightlyReport, buildNightlyReport } from "./report.js";

const HEAD = "b".repeat(40);
const SUBJECT = { repository: "acme/web", commitSha: HEAD };

const IDENTITY: NightlyReportIdentity = {
  repository: "acme/web",
  branch: "main",
  baseSha: null,
  headSha: HEAD,
  policyVersion: "policy-v1",
  schemaVersion: NIGHTLY_REPORT_SCHEMA_VERSION,
};

const POLICY: NightlyPolicy = {
  reportableDefectClasses: ["disabled-tls-verification", "leaked-credential"],
  fixableDefectClasses: ["disabled-tls-verification"],
};

const FIXERS = { "disabled-tls-verification": new TlsFixer() };

function tlsFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    subject: SUBJECT,
    primaryRegion: { path: "src/http.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "disables TLS verification" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

function build(findings: Finding[], coverage = COMPLETE_COVERAGE, fixers: Record<string, TlsFixer> = FIXERS) {
  const { decision, fixes } = generateFixes(findings, evaluateNightly(findings, POLICY, coverage), fixers);
  return buildNightlyReport({ identity: IDENTITY, findings, decision, fixes });
}

describe("buildNightlyReport", () => {
  it("splits the single disposition axis into visibility and remediation", () => {
    const report = build([
      tlsFinding(),
      tlsFinding({ defectClass: "leaked-credential", ruleId: "SECRET.AWS", primaryRegion: { path: "src/config.ts", startLine: 1, endLine: 1, snippet: "AKIA" } }),
      tlsFinding({ validation: "refuted", primaryRegion: { path: "test/http.test.ts", startLine: 1, endLine: 1, snippet: "rejectUnauthorized: false" } }),
    ]);

    const byPath = new Map(report.findings.map((f) => [f.region.path, f]));
    // propose_fix -> surfaced with a concrete proposal.
    expect(byPath.get("src/http.ts")!.visibility).toBe("surfaced");
    expect(byPath.get("src/http.ts")!.remediation).toMatchObject({ state: "proposed", reason: "deterministic_patch_ready" });
    // report -> surfaced, and an attempt is OWED (brief 03 attempts every one).
    expect(byPath.get("src/config.ts")!.visibility).toBe("surfaced");
    expect(byPath.get("src/config.ts")!.remediation).toEqual({ state: "pending", reason: "attempt_owed", proposal: null });
    // suppress -> audit only: no remediation record at all.
    expect(byPath.get("test/http.test.ts")!.visibility).toBe("suppressed");
    expect(byPath.get("test/http.test.ts")!.remediation).toBeNull();

    expect(report.summary).toEqual({ surfaced: 2, suppressed: 1, proposals: 1, requiredGaps: 0 });
  });

  it("records a fixable-but-unpatchable finding as surfaced with unavailable remediation", () => {
    const report = build([tlsFinding()], COMPLETE_COVERAGE, {});
    expect(report.findings[0]!.visibility).toBe("surfaced");
    expect(report.findings[0]!.visibilityReason).toBe("fix_unavailable");
    expect(report.findings[0]!.remediation).toEqual({ state: "unavailable", reason: "fixer_declined", proposal: null });
    expect(report.summary.proposals).toBe(0);
  });

  it("binds every occurrence and proposal to the report identity", () => {
    const finding = tlsFinding();
    const report = build([finding]);
    const expected = findingOccurrenceId({ report: IDENTITY, findingKey: findingKey(finding) });
    expect(report.findings[0]!.occurrenceId).toBe(expected);
    expect(report.findings[0]!.remediation?.proposal?.occurrenceId).toBe(expected);
    expect(report.findings[0]!.remediation?.proposal?.provenance).toMatchObject({ fixerKind: "deterministic", modelId: null });

    // A later candidate re-identifies the same defect, so nothing can be matched
    // against the previous night's already-closed work.
    const later = buildNightlyReport({
      identity: { ...IDENTITY, baseSha: HEAD, headSha: "c".repeat(40) },
      findings: [finding],
      ...(() => {
        const { decision, fixes } = generateFixes([finding], evaluateNightly([finding], POLICY, COMPLETE_COVERAGE), FIXERS);
        return { decision, fixes };
      })(),
    });
    expect(later.reportId).not.toBe(report.reportId);
    expect(later.findings[0]!.occurrenceId).not.toBe(report.findings[0]!.occurrenceId);
    expect(later.findings[0]!.remediation?.proposal?.proposalId).not.toBe(report.findings[0]!.remediation?.proposal?.proposalId);
  });

  it("carries coverage through and marks a gapped run incomplete", () => {
    const report = build([], coverageFrom([{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "429" }]));
    expect(report.requiredCoverageComplete).toBe(false);
    expect(report.coverage.gaps).toHaveLength(1);
    expect(report.summary.requiredGaps).toBe(1);
  });

  it("is stable across replays of the same inputs", () => {
    const findings = [tlsFinding()];
    expect(build(findings)).toEqual(build(findings));
  });
});

describe("abstainedNightlyReport", () => {
  it("claims nothing and records the whole-analysis gap", () => {
    const report = abstainedNightlyReport(IDENTITY, {
      dispositions: [],
      summary: { reported: 0, proposedFixes: 0, suppressed: 0 },
      coverage: analysisFailed("scm read failed"),
    });
    expect(report.findings).toEqual([]);
    expect(report.requiredCoverageComplete).toBe(false);
    expect(report.coverage.gaps[0]).toMatchObject({ analyzerId: "analysis", code: "provider_unavailable" });
  });
});
