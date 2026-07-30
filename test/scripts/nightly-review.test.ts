import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitPayload, isSafeRef, renderManualNightly, resolveBranchHead } from "../../scripts/nightly-review.js";
import type { NightlyEvidenceSnapshot } from "../../src/app/nightly-evidence-query.js";

/**
 * Offline unit tests for the nightly-review seams that guard the error/injection
 * paths:
 *  - isSafeRef: a branch/sha ref is interpolated into a `gh api` path, so `..`
 *    traversal, query/fragment splices, and control chars must be rejected BEFORE
 *    they reach the URL.
 *  - resolveBranchHead: an unexpected/malformed `gh` payload maps to the friendly
 *    message + exit 1, never an opaque TypeError from dereferencing `.sha`.
 * Importing the module must NOT run `main()` (entrypoint-guarded), so these run
 * without any network, real `gh`, or Postgres.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isSafeRef", () => {
  it("accepts ordinary branch names and shas", () => {
    expect(isSafeRef("main")).toBe(true);
    expect(isSafeRef("feature/github-app-reader")).toBe(true);
    expect(isSafeRef("release-1.2.3")).toBe(true);
    expect(isSafeRef("a".repeat(40))).toBe(true);
  });

  it("rejects traversal, path/query/fragment splices, and control chars", () => {
    expect(isSafeRef("")).toBe(false);
    expect(isSafeRef("..")).toBe(false);
    expect(isSafeRef("feature/../../etc")).toBe(false); // `..` traversal
    expect(isSafeRef("main?foo=bar")).toBe(false); // query splice
    expect(isSafeRef("main#frag")).toBe(false); // fragment splice
    expect(isSafeRef("main branch")).toBe(false); // space
    expect(isSafeRef("main%2f..")).toBe(false); // percent-encoding
    expect(isSafeRef("/leading-slash")).toBe(false);
    expect(isSafeRef("main\n")).toBe(false); // control char
  });
});

describe("resolveBranchHead", () => {
  it("accepts a well-formed commit payload", () => {
    const sha = "a".repeat(40);
    const gh = vi.fn(() => ({ sha, html_url: "https://example/commit/abc" }));
    expect(resolveBranchHead(gh, "acme/widgets", "main")).toEqual({
      headSha: sha,
      htmlUrl: "https://example/commit/abc",
    });
  });

  it("exits 1 on a payload with no sha (instead of a TypeError)", () => {
    const gh = vi.fn(() => ({ message: "Not Found", status: "404" }));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => resolveBranchHead(gh, "acme/widgets", "main")).toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 when gh itself throws (transport/auth failure)", () => {
    const gh = vi.fn(() => {
      throw new Error("gh: not authenticated");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => resolveBranchHead(gh, "acme/widgets", "main")).toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("CommitPayload rejects a non-40-char sha", () => {
    expect(CommitPayload.safeParse({ sha: "abc", html_url: "x" }).success).toBe(false);
    expect(CommitPayload.safeParse({ sha: "a".repeat(40), html_url: "" }).success).toBe(false);
  });
});

/**
 * The manual command exists for controlled runs and backfills, which means an
 * operator will compare its terminal output against the parent issue and the check
 * the hosted scheduler produces. Those must agree.
 */
describe("renderManualNightly", () => {
  const HEAD = "a".repeat(40);

  function snapshot(overrides: Partial<NightlyEvidenceSnapshot> = {}): NightlyEvidenceSnapshot {
    return {
      repository: "acme/api",
      branch: "trunk",
      candidateSha: HEAD,
      reports: [],
      requiredCoverageComplete: true,
      incompleteReports: 0,
      surfacedFindings: 0,
      openFindings: 0,
      awaitingVerification: 0,
      resolvedFindings: 0,
      dismissedFindings: 0,
      openProposals: 0,
      failedProposals: 0,
      ...overrides,
    };
  }

  it("prints the hosted morning render VERBATIM when the night produced a work graph", () => {
    const out = renderManualNightly({
      morning: { title: "Nightly review: INCOMPLETE — 1 coverage gap, 2 findings", body: "## Coverage\n\nheld" },
      snapshot: snapshot({ requiredCoverageComplete: false }),
      headSha: HEAD,
      runState: "decided",
      completeWatermark: null,
      flushed: 6,
      deadLettered: 0,
      writerBackend: "github-app",
    }).join("\n");

    // Same bytes as the check and the parent issue: an operator diffing the two must
    // find nothing.
    expect(out).toContain("Nightly review: INCOMPLETE — 1 coverage gap, 2 findings");
    expect(out).toContain("## Coverage\n\nheld");
    expect(out).toContain("- Complete-review watermark: none yet");
    expect(out).toContain("- Effects dispatched: 6 (writer: github-app)");
  });

  it("says the watermark is HELD behind the candidate it just reviewed", () => {
    const out = renderManualNightly({
      morning: { title: "t", body: "b" },
      snapshot: snapshot({ requiredCoverageComplete: false }),
      headSha: HEAD,
      runState: "decided",
      completeWatermark: "b".repeat(40),
      flushed: 3,
      deadLettered: 2,
      writerBackend: "gh-cli",
    }).join("\n");
    expect(out).toContain("(HELD behind this candidate)");
    // Undelivered work is never silent, even when the durable report is complete.
    expect(out).toContain("**2 outbox row(s) dead-lettered**");
  });

  it("falls back to the evidence snapshot for a complete night with no work, coverage first", () => {
    const out = renderManualNightly({
      morning: null,
      snapshot: snapshot(),
      headSha: HEAD,
      runState: "decided",
      completeWatermark: HEAD,
      flushed: 1,
      deadLettered: 0,
      writerBackend: "gh-cli",
    }).join("\n");

    expect(out).toContain("Nightly review: clean");
    expect(out.indexOf("## Coverage")).toBeLessThan(out.indexOf("## Findings"));
    expect(out).toContain("Required analyzer coverage is **complete**");
    expect(out).toContain("(advanced to this candidate)");
  });

  it("cannot title an INCOMPLETE range as clean, even with nothing to link", () => {
    const out = renderManualNightly({
      morning: null,
      snapshot: snapshot({
        requiredCoverageComplete: false,
        incompleteReports: 1,
        reports: [
          {
            reportId: "report-1",
            repository: "acme/api",
            branch: "trunk",
            baseSha: null,
            headSha: HEAD,
            policyVersion: "policy-v1",
            requiredCoverageComplete: false,
            summary: { surfaced: 0, suppressed: 0, proposals: 0, requiredGaps: 1 },
            coverageGaps: [{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "429" }],
            parentIssue: null,
            findings: [],
            createdAt: new Date("2026-07-15T02:00:00.000Z"),
          },
        ],
      }),
      headSha: HEAD,
      runState: "decided",
      completeWatermark: null,
      flushed: 1,
      deadLettered: 0,
      writerBackend: "gh-cli",
    }).join("\n");

    expect(out).toMatch(/^Nightly review: INCOMPLETE — 1 coverage gap, 0 findings/);
    expect(out).toContain("model-analyzer: provider_unavailable");
    expect(out).toContain("the complete-review watermark is HELD");
    expect(out).not.toContain("clean");
  });
});
