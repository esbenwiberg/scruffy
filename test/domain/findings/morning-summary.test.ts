import { describe, expect, it } from "vitest";
import { COMPLETE_COVERAGE, coverageFrom } from "../../../src/domain/evidence/coverage.js";
import { deriveParentClosure } from "../../../src/domain/fixes/lifecycle.js";
import {
  nightlyReviewTitle,
  openItemCount,
  renderMorningSummary,
  type MorningChildView,
  type MorningSummaryInput,
} from "../../../src/domain/findings/morning-summary.js";

/**
 * The morning render, in isolation.
 *
 * `test/harness/nightly-self-fix.test.ts` proves the two surfaces are congruent over
 * real persisted state. This suite pins the cases that state is expensive to reach
 * but an operator will eventually hit anyway: work Scruffy FAILED to publish or
 * deliver, a finding no fixer or model could serve, and the counting rules behind the
 * title. Those are the paths where an under-report is silent, so they get direct
 * coverage rather than waiting for a production morning to surface them.
 */

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function child(overrides: Partial<MorningChildView> = {}): MorningChildView {
  return {
    workItemId: "wi-finding",
    kind: "finding",
    title: "disabled-tls-verification in src/http.ts:3",
    resolution: "open",
    issue: { number: 11, url: "https://example.test/issues/11" },
    publicationError: null,
    remediation: { state: "proposed", reason: "deterministic fixer produced a patch" },
    proposal: null,
    verification: null,
    dismissal: null,
    ...overrides,
  };
}

function input(overrides: Partial<MorningSummaryInput> = {}): MorningSummaryInput {
  const children = overrides.children ?? [child()];
  const requiredCoverageComplete = overrides.requiredCoverageComplete ?? true;
  return {
    repository: "acme/api",
    branch: "trunk",
    headSha: HEAD,
    baseSha: BASE,
    reportId: "report-1",
    requiredCoverageComplete,
    coverage: requiredCoverageComplete ? COMPLETE_COVERAGE : coverageFrom([{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "429" }]),
    summary: { surfaced: 1, suppressed: 0, proposals: 1, requiredGaps: requiredCoverageComplete ? 0 : 1 },
    parent: { workItemId: "wi-parent", issue: { number: 10, url: "https://example.test/issues/10" } },
    ...overrides,
    children,
    closure: overrides.closure ?? deriveParentClosure({
      requiredCoverageComplete,
      children: children.map((c) => ({
        workItemId: c.workItemId,
        title: c.title,
        resolution: c.resolution,
        deliveryFailed: c.proposal?.deliveryError !== null && c.proposal?.deliveryError !== undefined,
        publicationFailed: c.publicationError !== null,
      })),
    }),
  };
}

describe("nightlyReviewTitle", () => {
  it("leads with coverage and never says clean when a required gap stands", () => {
    expect(
      nightlyReviewTitle({ requiredCoverageComplete: false, requiredGaps: 2, surfaced: 0, proposals: 0, openItems: 2 }),
    ).toBe("Nightly review: INCOMPLETE — 2 coverage gaps, 0 findings, 2 open items");
  });

  it("says clean only for a COMPLETE run that surfaced nothing", () => {
    expect(nightlyReviewTitle({ requiredCoverageComplete: true, requiredGaps: 0, surfaced: 0, proposals: 0, openItems: 0 })).toBe(
      "Nightly review: clean",
    );
    // Everything closed, but the night did find things: a human deserves the difference.
    expect(nightlyReviewTitle({ requiredCoverageComplete: true, requiredGaps: 0, surfaced: 3, proposals: 2, openItems: 0 })).toBe(
      "Nightly review: all items resolved or dismissed",
    );
  });

  it("omits the open-item count at gate time, when no lifecycle exists yet", () => {
    expect(nightlyReviewTitle({ requiredCoverageComplete: true, requiredGaps: 0, surfaced: 2, proposals: 1, openItems: null })).toBe(
      "Nightly review: 2 findings (1 fix proposed)",
    );
  });
});

describe("openItemCount", () => {
  it("counts each unresolved child once, whatever else is wrong with it", () => {
    const count = openItemCount({
      requiredCoverageComplete: true,
      children: [
        child({ workItemId: "a", resolution: "open", publicationError: "403" }),
        child({ workItemId: "b", resolution: "awaiting_verification" }),
        child({ workItemId: "c", resolution: "resolved" }),
        child({ workItemId: "d", resolution: "dismissed" }),
      ],
    });
    expect(count).toBe(2);
  });

  it("does not double-count a coverage gap that is already a child work item", () => {
    // The gap is one piece of work for a human. Counting it as both a child and a
    // coverage flag would overstate the morning and make the two surfaces disagree
    // with the list right underneath them.
    expect(
      openItemCount({
        requiredCoverageComplete: false,
        children: [child({ workItemId: "gap", kind: "coverage_gap" }), child({ workItemId: "finding" })],
      }),
    ).toBe(2);
  });

  it("still counts incomplete coverage when no coverage child represents it", () => {
    // The coverage child failed to be created (or was already closed): coverage is
    // owed regardless, and must not vanish from the count.
    expect(openItemCount({ requiredCoverageComplete: false, children: [] })).toBe(1);
    expect(
      openItemCount({ requiredCoverageComplete: false, children: [child({ kind: "coverage_gap", resolution: "dismissed" })] }),
    ).toBe(1);
  });
});

describe("renderMorningSummary", () => {
  it("puts coverage before finding counts and states the held watermark", () => {
    const { title, body } = renderMorningSummary(input({ requiredCoverageComplete: false }));
    expect(title).toMatch(/^Nightly review: INCOMPLETE/);
    expect(body.indexOf("## Coverage")).toBeLessThan(body.indexOf("## Findings"));
    expect(body.indexOf("## Findings")).toBeLessThan(body.indexOf("## Work items"));
    expect(body).toContain("the complete-review watermark is HELD");
    expect(body).toContain("`model-analyzer`: `provider_unavailable` — 429");
  });

  it("names an unpublished parent and child issue instead of omitting them", () => {
    const { body } = renderMorningSummary(
      input({
        parent: { workItemId: "wi-parent", issue: null },
        children: [child({ issue: null, publicationError: "403 from the Issues API" })],
      }),
    );
    expect(body).toContain("- Parent: `wi-parent` — **issue not published**");
    expect(body).toContain("**issue not published** (403 from the Issues API)");
    // And loudly, in its own section, so nobody has to read every child to find it.
    expect(body).toContain("## Failed or unavailable work");
    expect(body).toContain("wi-finding`: child issue could not be published — 403 from the Issues API");
  });

  it("lists a failed delivery and a finding no fixer could serve", () => {
    const { body } = renderMorningSummary(
      input({
        children: [
          child({
            workItemId: "wi-undelivered",
            proposal: {
              delivery: "delivery_failed",
              ci: "unknown",
              ciHeadSha: null,
              merge: "open",
              pr: null,
              deliveryError: "branch already exists for a different proposal",
            },
          }),
          child({
            workItemId: "wi-unservable",
            remediation: { state: "unavailable", reason: "no deterministic fixer and the model declined" },
          }),
        ],
      }),
    );
    expect(body).toContain("no pull request — delivery `delivery_failed`");
    expect(body).toContain("**Fix delivery failed**: branch already exists for a different proposal");
    expect(body).toContain("No pull request: remediation `unavailable`");
    expect(body).toContain("wi-unservable`: no patch (`unavailable`) — no deterministic fixer and the model declined");
  });

  it("omits the failure section entirely when nothing failed", () => {
    const { body } = renderMorningSummary(input());
    expect(body).not.toContain("## Failed or unavailable work");
  });

  it("refuses to let a merge stand in for verification", () => {
    const merged = child({
      resolution: "awaiting_verification",
      proposal: {
        delivery: "ready_open",
        ci: "passed",
        ciHeadSha: "c".repeat(40),
        merge: "merged",
        pr: { number: 7, url: "https://example.test/pull/7" },
        deliveryError: null,
      },
    });
    const { body } = renderMorningSummary(input({ children: [merged] }));
    expect(body).toContain("CI `passed` at `cccccccccccc`, merge `merged`");
    expect(body).toContain("Post-merge verification: not yet attempted — the merge does NOT resolve this item.");
    expect(body).toContain("This run stays open until:");
    expect(body).toContain("a merged fix clears its finding only after Scruffy verifies");
  });

  it("records a human dismissal as a decision, not as a verified fix", () => {
    const { body } = renderMorningSummary(
      input({
        children: [
          child({
            resolution: "dismissed",
            dismissal: { actor: "octocat", stateReason: "not_planned", closedAt: new Date("2026-07-15T09:00:00.000Z") },
          }),
        ],
      }),
    );
    expect(body).toContain("Dismissed by `octocat` (reason: `not_planned`)");
    expect(body).toContain("recorded as a human decision, not as a verified fix");
  });

  it("marks a CI verdict that belongs to no current head as unknown rather than stale", () => {
    const { body } = renderMorningSummary(
      input({
        children: [
          child({
            proposal: {
              delivery: "draft_open",
              ci: "unknown",
              ciHeadSha: null,
              merge: "open",
              pr: { number: 9, url: "https://example.test/pull/9" },
              deliveryError: null,
            },
          }),
        ],
      }),
    );
    expect(body).toContain("CI `unknown` (no evidence for the current PR head)");
    expect(body).toContain("Opened as a DRAFT: structurally safe and policy-compliant, but not independently confirmed.");
  });
});
