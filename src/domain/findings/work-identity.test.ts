import { describe, expect, it } from "vitest";
import type { Finding } from "../evidence/types.js";
import {
  DETERMINISTIC_FIXER_SUITE_VERSION,
  FIX_PROPOSAL_SCHEMA_VERSION,
  NIGHTLY_REPORT_SCHEMA_VERSION,
  NightlyReportIdentity,
  coverageWorkItemId,
  deterministicFixerProvenance,
  findingOccurrenceId,
  findingWorkItemId,
  fixProposalId,
  nightlyReportId,
  occurrenceOf,
  runWorkItemId,
  type RemediationProvenance,
} from "./work-identity.js";

const REPO = "acme/web";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const LATER_HEAD = "c".repeat(40);

function report(overrides: Partial<NightlyReportIdentity> = {}): NightlyReportIdentity {
  return {
    repository: REPO,
    branch: "main",
    baseSha: BASE,
    headSha: HEAD,
    policyVersion: "policy-v1",
    schemaVersion: NIGHTLY_REPORT_SCHEMA_VERSION,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    subject: { repository: REPO, commitSha: HEAD },
    primaryRegion: { path: "src/http.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "disables TLS verification" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

const DETERMINISTIC: RemediationProvenance = deterministicFixerProvenance("disabled-tls-verification");
const MODEL: RemediationProvenance = {
  fixerKind: "model",
  fixerId: "llm-remediation",
  fixerVersion: "1",
  modelId: "claude-x",
  promptVersion: "remediation-v1",
  proposalSchemaVersion: FIX_PROPOSAL_SCHEMA_VERSION,
};

describe("NightlyReportIdentity", () => {
  it("accepts a first-ever review (null base) and rejects malformed shas", () => {
    expect(NightlyReportIdentity.parse(report({ baseSha: null })).baseSha).toBeNull();
    expect(() => NightlyReportIdentity.parse(report({ headSha: "abc" }))).toThrow();
    expect(() => NightlyReportIdentity.parse(report({ branch: "" }))).toThrow();
    expect(() => NightlyReportIdentity.parse(report({ repository: "no-owner" }))).toThrow();
  });
});

describe("nightlyReportId", () => {
  it("is stable for an exact replay of the same identity", () => {
    expect(nightlyReportId(report())).toBe(nightlyReportId(report()));
  });

  it("changes for every identity component", () => {
    const baseline = nightlyReportId(report());
    const variants = [
      report({ repository: "acme/api" }),
      report({ branch: "release" }),
      report({ baseSha: null }),
      report({ headSha: LATER_HEAD }),
      report({ policyVersion: "policy-v2" }),
      report({ schemaVersion: "nightly-report-2" }),
    ].map(nightlyReportId);
    expect(new Set([baseline, ...variants]).size).toBe(variants.length + 1);
  });

  it("cannot be aliased by shifting characters between components", () => {
    // A delimiter-joined key would let `branch = "main"` + `policy = "v1"` collide
    // with `branch = "mainv1"` + `policy = ""`. JSON-encoded components cannot.
    const a = nightlyReportId(report({ branch: "main", policyVersion: "v1" }));
    const b = nightlyReportId(report({ branch: "mainv1", policyVersion: "1" }));
    expect(a).not.toBe(b);
  });
});

describe("findingOccurrenceId", () => {
  it("differs when two findings share defect class, path, and line but differ by RULE", () => {
    const identity = report();
    const a = occurrenceOf(identity, finding({ ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE" }));
    const b = occurrenceOf(identity, finding({ ruleId: "TLS.INSECURE_AGENT" }));
    expect(a.findingKey).not.toBe(b.findingKey);
    expect(findingOccurrenceId(a)).not.toBe(findingOccurrenceId(b));
  });

  it("differs when the same defect is seen on a different CANDIDATE sha", () => {
    // The whole point of candidate-bound identity: today's occurrence of the same
    // rule at the same line must not match yesterday's (already-closed) work.
    const today = occurrenceOf(report({ baseSha: HEAD, headSha: LATER_HEAD }), finding());
    const yesterday = occurrenceOf(report(), finding());
    expect(today.findingKey).toBe(yesterday.findingKey); // same normalized defect...
    expect(findingOccurrenceId(today)).not.toBe(findingOccurrenceId(yesterday)); // ...different occurrence
  });

  it("is stable for an exact replay of the same report and finding", () => {
    expect(findingOccurrenceId(occurrenceOf(report(), finding()))).toBe(findingOccurrenceId(occurrenceOf(report(), finding())));
  });

  it("ignores evidence that does not change the defect's identity", () => {
    const withExtraEvidence = finding({
      supporting: [
        { trust: "deterministic", statement: "disables TLS verification" },
        { trust: "model-asserted", statement: "MITM risk" },
      ],
    });
    expect(findingOccurrenceId(occurrenceOf(report(), withExtraEvidence))).toBe(
      findingOccurrenceId(occurrenceOf(report(), finding())),
    );
  });
});

describe("fixProposalId", () => {
  it("is stable for an exact replay of the same occurrence and versions", () => {
    const occurrence = occurrenceOf(report(), finding());
    expect(fixProposalId({ occurrence, provenance: DETERMINISTIC })).toBe(
      fixProposalId({ occurrence, provenance: DETERMINISTIC }),
    );
  });

  it("differs per fixer, model, prompt, and proposal schema version", () => {
    const occurrence = occurrenceOf(report(), finding());
    const ids = [
      DETERMINISTIC,
      MODEL,
      { ...MODEL, modelId: "claude-y" },
      { ...MODEL, promptVersion: "remediation-v2" },
      { ...MODEL, fixerVersion: "2" },
      { ...MODEL, proposalSchemaVersion: "fix-proposal-2" },
      { ...DETERMINISTIC, fixerVersion: `${DETERMINISTIC_FIXER_SUITE_VERSION}-next` },
    ].map((provenance) => fixProposalId({ occurrence, provenance }));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("differs across candidates even for identical fixer versions", () => {
    const provenance = DETERMINISTIC;
    const today = fixProposalId({ occurrence: occurrenceOf(report({ headSha: LATER_HEAD }), finding()), provenance });
    const yesterday = fixProposalId({ occurrence: occurrenceOf(report(), finding()), provenance });
    expect(today).not.toBe(yesterday);
  });
});

describe("work item ids", () => {
  it("are stable, distinct per kind, and derived only from durable identity", () => {
    const identity = report();
    const occurrence = occurrenceOf(identity, finding());
    const ids = [
      runWorkItemId(identity),
      findingWorkItemId(occurrence),
      coverageWorkItemId(identity, { analyzerId: "model-analyzer", code: "provider_unavailable" }),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(runWorkItemId(identity)).toBe(runWorkItemId(report()));
    expect(findingWorkItemId(occurrence)).toBe(findingWorkItemId(occurrenceOf(report(), finding())));
  });

  it("ignores the free-form gap detail so a retry does not mint a second coverage item", () => {
    const identity = report();
    expect(coverageWorkItemId(identity, { analyzerId: "model-analyzer", code: "provider_unavailable" })).toBe(
      coverageWorkItemId(identity, { analyzerId: "model-analyzer", code: "provider_unavailable" }),
    );
    expect(coverageWorkItemId(identity, { analyzerId: "model-analyzer", code: "unparseable_output" })).not.toBe(
      coverageWorkItemId(identity, { analyzerId: "model-analyzer", code: "provider_unavailable" }),
    );
  });

  it("prefixes ids by kind so an id can never be mistaken for another entity's", () => {
    const identity = report();
    expect(nightlyReportId(identity)).toMatch(/^nrp_[0-9a-f]{32}$/);
    expect(findingOccurrenceId(occurrenceOf(identity, finding()))).toMatch(/^nfo_[0-9a-f]{32}$/);
    expect(fixProposalId({ occurrence: occurrenceOf(identity, finding()), provenance: DETERMINISTIC })).toMatch(
      /^nfp_[0-9a-f]{32}$/,
    );
    expect(runWorkItemId(identity)).toMatch(/^nwi_run_[0-9a-f]{32}$/);
  });
});
