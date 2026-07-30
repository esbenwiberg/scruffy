import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NightlyEvidenceQuery,
  summarizeNightlyEvidence,
  type NightlyEvidenceFinding,
  type NightlyEvidenceQueryInput,
  type NightlyEvidenceReadPort,
  type NightlyEvidenceReport,
} from "../../src/app/nightly-evidence-query.js";
import { releaseToCheck, RELEASE_CHECK_NAME } from "../../src/effects/check-run.js";
import type { ReleaseDecision } from "../../src/gates/release/decision.js";

/**
 * The provider-neutral nightly EVIDENCE boundary, and the boundary it must not
 * cross.
 *
 * Two halves, both load-bearing for `release-boundary-remains-advisory-and-separate`:
 *
 *  - the query exists, is read-only, is addressable by repository / branch /
 *    immutable candidate, and reports "not completely reviewed" for a candidate it has
 *    no evidence for (so an aggregation can never read silence as a clean bill);
 *  - the release gate is UNCHANGED by its existence — it does not import nightly
 *    lifecycle state, and its check stays advisory/neutral. That half is asserted
 *    against the real source tree, because "we did not couple them" is exactly the
 *    kind of claim that rots silently.
 */

const REPO = "acme/api";
const HEAD = "a".repeat(40);

function finding(overrides: Partial<NightlyEvidenceFinding> = {}): NightlyEvidenceFinding {
  return {
    occurrenceId: "occ-1",
    findingKey: "key-1",
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    path: "src/http.ts",
    startLine: 5,
    endLine: 5,
    visibility: "surfaced",
    visibilityReason: "reportable defect class",
    resolution: "open",
    remediation: { state: "proposed", reason: "deterministic fixer produced a patch" },
    proposal: null,
    verification: null,
    dismissed: false,
    ...overrides,
  };
}

function report(overrides: Partial<NightlyEvidenceReport> = {}): NightlyEvidenceReport {
  return {
    reportId: "report-1",
    repository: REPO,
    branch: "trunk",
    baseSha: null,
    headSha: HEAD,
    policyVersion: "policy-v1",
    requiredCoverageComplete: true,
    summary: { surfaced: 0, suppressed: 0, proposals: 0, requiredGaps: 0 },
    coverageGaps: [],
    parentIssue: null,
    findings: [],
    createdAt: new Date("2026-03-01T02:00:00.000Z"),
    ...overrides,
  };
}

/** Records what the query asked for; returns whatever the test seeded. */
class RecordingReader implements NightlyEvidenceReadPort {
  readonly calls: (NightlyEvidenceQueryInput & { limit: number })[] = [];
  constructor(private readonly rows: NightlyEvidenceReport[] = []) {}
  async reports(input: NightlyEvidenceQueryInput & { limit: number }): Promise<NightlyEvidenceReport[]> {
    this.calls.push({ ...input });
    return this.rows;
  }
}

describe("NightlyEvidenceQuery", () => {
  it("queries by repository and applies a default bound", async () => {
    const reader = new RecordingReader([report()]);
    const snapshot = await new NightlyEvidenceQuery(reader).forRepository({ repository: REPO });

    expect(reader.calls[0]).toEqual({ repository: REPO, limit: 20 });
    expect(snapshot).toMatchObject({ repository: REPO, branch: null, candidateSha: null, requiredCoverageComplete: true });
    expect(snapshot.reports).toHaveLength(1);
  });

  it("narrows to one branch and one immutable candidate", async () => {
    const reader = new RecordingReader([report()]);
    const query = new NightlyEvidenceQuery(reader);

    await query.forRepository({ repository: REPO, branch: "trunk", limit: 5 });
    expect(reader.calls[0]).toEqual({ repository: REPO, branch: "trunk", limit: 5 });

    const snapshot = await query.forCandidate(REPO, HEAD);
    expect(reader.calls[1]).toEqual({ repository: REPO, candidateSha: HEAD, limit: 20 });
    expect(snapshot.candidateSha).toBe(HEAD);
  });

  it("reports a candidate with NO nightly evidence as not completely reviewed", async () => {
    const snapshot = await new NightlyEvidenceQuery(new RecordingReader([])).forCandidate(REPO, HEAD);
    // "Never reviewed" and "reviewed and clean" must not produce the same answer:
    // this is the one property a later release aggregation is allowed to lean on.
    expect(snapshot.requiredCoverageComplete).toBe(false);
    expect(snapshot.reports).toEqual([]);
    expect(snapshot.surfacedFindings).toBe(0);
  });

  it("is READ-ONLY: neither the port nor the query exposes a way to mutate lifecycle state", () => {
    const query = new NightlyEvidenceQuery(new RecordingReader());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(query)).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(["forCandidate", "forRepository"]);
    // The read port itself has exactly one method, so no adapter can smuggle a
    // write in behind this boundary.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(new RecordingReader())).filter((n) => n !== "constructor")).toEqual(
      ["reports"],
    );
  });
});

describe("summarizeNightlyEvidence", () => {
  it("rolls up resolution, proposal and coverage state from the reports in the same snapshot", () => {
    const snapshot = summarizeNightlyEvidence(
      { repository: REPO, branch: "trunk", candidateSha: null },
      [
        report({
          reportId: "report-1",
          findings: [
            finding({ occurrenceId: "occ-open", resolution: "open" }),
            finding({
              occurrenceId: "occ-awaiting",
              resolution: "awaiting_verification",
              proposal: {
                proposalId: "prop-1",
                delivery: "ready_open",
                ci: "passed",
                ciHeadSha: "c".repeat(40),
                merge: "merged",
                pullRequest: { number: 7, url: "https://example.test/pr/7" },
                deliveryError: null,
              },
            }),
            finding({
              occurrenceId: "occ-failed",
              resolution: "open",
              proposal: {
                proposalId: "prop-2",
                delivery: "delivery_failed",
                ci: "unknown",
                ciHeadSha: null,
                merge: "open",
                pullRequest: null,
                deliveryError: "branch collided",
              },
            }),
            // Suppressed findings are audit records, not open work.
            finding({ occurrenceId: "occ-refuted", visibility: "suppressed", resolution: "open", remediation: null }),
          ],
        }),
        report({
          reportId: "report-2",
          requiredCoverageComplete: false,
          coverageGaps: [{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "429" }],
          findings: [
            finding({ occurrenceId: "occ-resolved", resolution: "resolved" }),
            finding({ occurrenceId: "occ-dismissed", resolution: "dismissed", dismissed: true }),
          ],
        }),
      ],
    );

    expect(snapshot).toMatchObject({
      surfacedFindings: 5,
      openFindings: 2,
      awaitingVerification: 1,
      resolvedFindings: 1,
      dismissedFindings: 1,
      openProposals: 1,
      failedProposals: 1,
      incompleteReports: 1,
      // ONE incomplete report makes the whole snapshot incomplete: a partially
      // reviewed candidate is not a reviewed candidate.
      requiredCoverageComplete: false,
    });
  });

  it("does not count a queued proposal as having reached a human", () => {
    const snapshot = summarizeNightlyEvidence({ repository: REPO, branch: null, candidateSha: null }, [
      report({
        findings: [
          finding({
            proposal: {
              proposalId: "prop-1",
              delivery: "queued",
              ci: "unknown",
              ciHeadSha: null,
              merge: "open",
              pullRequest: null,
              deliveryError: null,
            },
          }),
        ],
      }),
    ]);
    expect(snapshot.openProposals).toBe(0);
    expect(snapshot.failedProposals).toBe(0);
  });
});

describe("the release boundary", () => {
  const RELEASE_DIR = new URL("../../src/gates/release/", import.meta.url).pathname;

  it("keeps release gate modules free of nightly lifecycle and evidence imports", async () => {
    const files = (await readdir(RELEASE_DIR)).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    // Forbidden imports, each one a way the advisory nightly lane could quietly
    // become an input to a release outcome. Scoped to the release gate's OWN
    // modules: `effects/check-run.ts` is shared rendering for all three gates, and
    // `releaseToCheck` is asserted separately below.
    const forbidden = [
      "nightly-evidence",
      "fix-lifecycle",
      "nightly-schedule",
      "morning-summary",
      "work-graph",
      "work-publication",
      "app/nightly",
      "gates/nightly",
    ];
    for (const file of files) {
      const source = await readFile(join(RELEASE_DIR, file), "utf8");
      for (const needle of forbidden) {
        expect(source, `${file} must not import ${needle}`).not.toContain(`from "${needle}`);
        expect(source, `${file} must not import ${needle}`).not.toMatch(new RegExp(`from "[^"]*${needle}[^"]*"`));
      }
    }
  });

  it("leaves the release check advisory and neutral", () => {
    const decision = {
      outcome: "stop",
      summary: { stopped: 1, escalated: 0, cleared: 0, notRelevant: 0 },
      dispositions: [
        {
          effect: "stops",
          defectClass: "leaked-credential",
          region: { path: "src/config.ts", startLine: 3, endLine: 3, snippet: "token" },
          reason: "confirmed blocker",
        },
      ],
    } as unknown as ReleaseDecision;

    const check = releaseToCheck(decision);
    // Even a STOP is neutral: nightly's new durable lifecycle did not promote the
    // release check to a blocking status.
    expect(check.conclusion).toBe("neutral");
    expect(check.title).toMatch(/^Release gate: STOP/);
    expect(check.summary).toContain("Shadow mode: this check is advisory and does not block publication.");
    expect(RELEASE_CHECK_NAME).toBe("scruffy/release");
  });
});
