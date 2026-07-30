import { describe, expect, it } from "vitest";
import {
  NightlyPublicationState,
  SCRUFFY_ISSUE_LABEL,
  WorkItemPublication,
  countPublications,
  issueLabelsFor,
  parseWorkItemIssueMarker,
  renderPublicationStatus,
  withIssueMarker,
  workItemIssueMarker,
} from "./work-publication.js";

/**
 * The publication contracts. Three things are being defended here:
 *  - the hidden marker round-trips, so a crashed publication can find its issue
 *    again without consulting a title or a lagging search index;
 *  - the schema refuses to store contradictory claims about one attempt, because a
 *    row that says both "published" and "could not be filed" renders as whichever
 *    field a reader happens to check;
 *  - the rendered status never implies success it does not have, and keeps "not
 *    filed yet" distinguishable from "could not be filed".
 */

const PARENT = "nwi_run_aaaaaaaaaaaaaaaa";
const CHILD = "nwi_fnd_bbbbbbbbbbbbbbbb";

function publication(overrides: Partial<WorkItemPublication> = {}): unknown {
  return {
    workItemId: CHILD,
    kind: "finding",
    title: "leaked-credential at src/config.ts:1",
    marker: workItemIssueMarker(CHILD),
    issue: null,
    attachedToParent: false,
    publicationError: null,
    attachmentError: null,
    ...overrides,
  };
}

const issue = (number: number) => ({
  provider: "github" as const,
  number,
  externalId: `${number}000`,
  url: `https://github.com/acme/web/issues/${number}`,
});

describe("work item issue marker", () => {
  it("round-trips the work-item id through a hidden HTML comment", () => {
    const marker = workItemIssueMarker(PARENT);
    expect(marker).toContain("<!--");
    expect(parseWorkItemIssueMarker(`Some body text.\n\n${marker}`)).toBe(PARENT);
  });

  it("is derived purely from the work-item id — same item, same marker", () => {
    expect(workItemIssueMarker(PARENT)).toBe(workItemIssueMarker(PARENT));
    // ...and a different work item (e.g. the same rule on a LATER candidate, which
    // has a different report identity) is a DIFFERENT marker, so today's finding can
    // never match yesterday's closed issue.
    expect(workItemIssueMarker(PARENT)).not.toBe(workItemIssueMarker(CHILD));
  });

  it("returns null for a body with no marker", () => {
    expect(parseWorkItemIssueMarker("just a body")).toBeNull();
    expect(parseWorkItemIssueMarker(null)).toBeNull();
    expect(parseWorkItemIssueMarker(undefined)).toBeNull();
  });

  it("appends the marker once — an update round-trip must not stack duplicates", () => {
    const marker = workItemIssueMarker(PARENT);
    const once = withIssueMarker("body", marker);
    expect(withIssueMarker(once, marker)).toBe(once);
    expect(once.split(marker)).toHaveLength(2);
  });

  it("labels every kind with the shared scoping label plus a kind label", () => {
    for (const kind of ["nightly_run", "finding", "coverage_gap"] as const) {
      expect(issueLabelsFor(kind)[0]).toBe(SCRUFFY_ISSUE_LABEL);
      expect(issueLabelsFor(kind)).toHaveLength(2);
    }
    expect(new Set(["nightly_run", "finding", "coverage_gap"].map((k) => issueLabelsFor(k as never)[1])).size).toBe(3);
  });
});

describe("WorkItemPublication", () => {
  it("accepts an unattempted item — 'not filed yet' is a real, storable state", () => {
    expect(() => WorkItemPublication.parse(publication())).not.toThrow();
  });

  it("refuses to hold both an issue and a terminal publication failure", () => {
    expect(() => WorkItemPublication.parse(publication({ issue: issue(5), publicationError: "refused" }))).toThrow(
      /cannot also carry a terminal publication failure/,
    );
  });

  it("refuses to hold both an attachment and a terminal attachment failure", () => {
    expect(() =>
      WorkItemPublication.parse(publication({ issue: issue(5), attachedToParent: true, attachmentError: "refused" })),
    ).toThrow(/cannot also carry a terminal attachment failure/);
  });

  it("refuses to attach the parent to itself", () => {
    expect(() =>
      WorkItemPublication.parse(publication({ workItemId: PARENT, kind: "nightly_run", issue: issue(5), attachedToParent: true })),
    ).toThrow(/no parent to attach to/);
  });

  it("refuses children without a parent", () => {
    expect(() => NightlyPublicationState.parse({ reportId: "nrp_1", parent: null, children: [publication()] })).toThrow(
      /children require a parent/,
    );
  });
});

describe("renderPublicationStatus", () => {
  const parent = publication({ workItemId: PARENT, kind: "nightly_run", title: "Nightly review", issue: issue(1) });

  function state(children: unknown[]) {
    return NightlyPublicationState.parse({ reportId: "nrp_1", parent, children });
  }

  it("reports full publication only when every item is filed AND attached", () => {
    const rendered = renderPublicationStatus(
      state([publication({ issue: issue(2), attachedToParent: true }), publication({ workItemId: "nwi_cov_c", kind: "coverage_gap", title: "gap", issue: issue(3), attachedToParent: true })]),
    );
    expect(rendered).toContain("Every planned work item was filed and attached");
    expect(rendered).toContain("3 planned, 3 filed as issues, 2/2 children attached");
  });

  it("names a child that COULD NOT be filed, and does not claim success", () => {
    const rendered = renderPublicationStatus(state([publication({ publicationError: "GitHub 403: Issues are disabled" })]));
    expect(rendered).toContain("not fully published");
    expect(rendered).toContain("could not be filed");
    expect(rendered).toContain("Issues are disabled");
    expect(rendered).not.toContain("Every planned work item was filed");
  });

  it("distinguishes 'not filed yet' from 'could not be filed'", () => {
    // Both are unpublished, but only one is a failure a human should act on; folding
    // them together would either raise a false alarm or hide a real one.
    const pending = renderPublicationStatus(state([publication()]));
    expect(pending).toContain("not filed yet");
    expect(pending).not.toContain("could not be filed");
  });

  it("names a child that was filed but could not be ATTACHED", () => {
    const rendered = renderPublicationStatus(state([publication({ issue: issue(2), attachmentError: "sub-issue rejected" })]));
    expect(rendered).toContain("#2 **could not be attached**");
    expect(rendered).toContain("sub-issue rejected");
  });

  it("counts only children on the attachment axis", () => {
    const counts = countPublications(state([publication({ issue: issue(2), attachedToParent: true })]));
    expect(counts).toEqual({ planned: 2, published: 2, attached: 1, failed: 0 });
  });

  it("says so plainly when a report planned no work at all", () => {
    const empty = NightlyPublicationState.parse({ reportId: "nrp_1", parent: null, children: [] });
    expect(renderPublicationStatus(empty)).toBe("No work items were planned for this report.");
    expect(countPublications(empty)).toEqual({ planned: 0, published: 0, attached: 0, failed: 0 });
  });
});
