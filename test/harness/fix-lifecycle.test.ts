import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/platform/clock.js";
import { FixReconciler } from "../../src/app/fix-reconciler.js";
import { PatchAppliedVerifier } from "../../src/gates/nightly/verify.js";
import { FakeScm, fakeSha } from "../../src/providers/scm/fake.js";
import { fixProposalExternalId } from "../../src/domain/fixes/delivery.js";
import { workItemIssueMarker, type IssueExternalRef } from "../../src/domain/findings/work-publication.js";
import { MemoryFixLifecycleStore, type SeedChild } from "../support/memory-fix-lifecycle.js";
import type { FakeIssue } from "../../src/providers/scm/fake.js";

/**
 * The fix lifecycle Scruffy does NOT control, driven end to end: repository CI,
 * a human merging, a human closing an issue, and what the merged result actually
 * looks like at the post-merge head.
 *
 * Real code in the middle — `FixReconciler`, the pure derivations in
 * `domain/fixes/lifecycle.ts`, and `PatchAppliedVerifier` — with deterministic
 * edges: a `FakeScm` that mirrors the GitHub adapter's mechanism, a `FixedClock`,
 * and an in-memory `NightlyFixLifecyclePort`. The SQL behind the same guards is
 * proved against real Postgres in the DB-gated suite at the bottom of this file.
 *
 * What these tests are for, in one sentence each:
 *
 *  - a green CI run on a head nobody is looking at any more must not read as a
 *    green run on the patch a human IS looking at;
 *  - a merge is not a fix, and the only thing that resolves a finding is looking
 *    at the immutable post-merge candidate and finding the defect gone;
 *  - a human's "won't fix" is recorded as a dismissal with their name on it, never
 *    laundered into "Scruffy verified this";
 *  - a parent nightly run stays open while any child is anything but terminal.
 */

const REPO = "acme/widgets";
const BRANCH = "main";
const HEAD = fakeSha("candidate-1");
const REPORT_ID = "nrp_candidate1";
const PARENT_ID = "nwi_parent";

const VULNERABLE = ["import https from 'https';", "const agent = new https.Agent({", "  rejectUnauthorized: false,", "});"].join("\n");
const PATCHED = VULNERABLE.replace("  rejectUnauthorized: false,", "  rejectUnauthorized: true,");
const PREIMAGE = "  rejectUnauthorized: false,";
const REPLACEMENT = "  rejectUnauthorized: true,";
const FIX_PATH = "src/http.ts";

interface Rig {
  scm: FakeScm;
  store: MemoryFixLifecycleStore;
  reconciler: FixReconciler;
  clock: FixedClock;
}

let rig: Rig;

beforeEach(() => {
  const clock = new FixedClock(new Date("2026-07-30T02:00:00.000Z"));
  const scm = new FakeScm();
  const store = new MemoryFixLifecycleStore(clock);
  rig = {
    scm,
    store,
    clock,
    reconciler: new FixReconciler({
      lifecycle: store,
      reader: scm,
      writer: scm,
      verifier: new PatchAppliedVerifier(scm),
      clock,
    }),
  };
});

/** Publish an issue through the fake exactly as the publication effect would. */
async function publishIssue(workItemId: string, title: string, body: string, labels: string[]): Promise<IssueExternalRef> {
  const ref = await rig.scm.upsertIssue({
    repository: REPO,
    marker: workItemIssueMarker(workItemId),
    labels,
    title,
    body,
  });
  return { provider: "github", number: ref.number, externalId: ref.id, url: ref.url };
}

interface FindingChildSpec {
  workItemId: string;
  occurrenceId: string;
  proposalId: string;
  /** Reviewed candidate the patch is anchored to. Defaults to the report head. */
  reviewedHeadSha?: string;
  draft?: boolean;
}

/**
 * Seed one surfaced finding: a published child issue, a durable proposal, and a
 * real PR opened through the fake writer (so the PR number, head sha and draft
 * state are the provider's answer rather than a test literal).
 */
async function seedFindingChild(spec: FindingChildSpec): Promise<{ child: SeedChild; prNumber: number; prHeadSha: string }> {
  const reviewedHeadSha = spec.reviewedHeadSha ?? HEAD;
  const issue = await publishIssue(spec.workItemId, `Fix disabled TLS verification in ${FIX_PATH}`, "finding body", [
    "scruffy",
    "scruffy:finding",
  ]);

  rig.scm.seedFileContent({ repository: REPO, commitSha: reviewedHeadSha }, FIX_PATH, VULNERABLE);

  const edits = [
    {
      path: FIX_PATH,
      startLine: 3,
      endLine: 3,
      replacement: REPLACEMENT,
      rationale: "enable certificate verification",
      expectedOriginal: PREIMAGE,
    },
  ];

  rig.store.seedProposal({
    proposalId: spec.proposalId,
    occurrenceId: spec.occurrenceId,
    reportId: REPORT_ID,
    workItemId: spec.workItemId,
    repository: REPO,
    baseBranch: BRANCH,
    branch: `scruffy/fix/disabled-tls-verification/${reviewedHeadSha.slice(0, 12)}/${spec.proposalId}`,
    reviewedHeadSha,
    defectClass: "disabled-tls-verification",
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    path: FIX_PATH,
    edits,
  });

  const opened = await rig.scm.openPullRequest({
    subject: { repository: REPO, commitSha: reviewedHeadSha },
    externalId: fixProposalExternalId(spec.proposalId),
    branch: `scruffy/fix/disabled-tls-verification/${reviewedHeadSha.slice(0, 12)}/${spec.proposalId}`,
    baseBranch: BRANCH,
    title: `Fix disabled TLS verification in ${FIX_PATH}`,
    body: "proposal",
    edits,
    draft: spec.draft ?? false,
    proposalId: spec.proposalId,
    childIssue: { number: issue.number, id: issue.externalId, url: issue.url },
  });
  await rig.store.recordDeliveryResult({
    proposalId: spec.proposalId,
    delivery: opened.draft ? "draft_open" : "ready_open",
    pr: { number: opened.number, url: opened.url, headSha: opened.headSha, draft: opened.draft },
  });

  return {
    child: {
      workItemId: spec.workItemId,
      kind: "finding",
      title: `Fix disabled TLS verification in ${FIX_PATH}`,
      body: "finding body",
      occurrenceId: spec.occurrenceId,
      issue,
    },
    prNumber: opened.number,
    prHeadSha: opened.headSha,
  };
}

async function seedReport(children: SeedChild[], requiredCoverageComplete = true): Promise<IssueExternalRef> {
  const parentIssue = await publishIssue(PARENT_ID, "Nightly review", "parent body", ["scruffy", "scruffy:nightly-run"]);
  rig.store.seedReport({
    reportId: REPORT_ID,
    repository: REPO,
    branch: BRANCH,
    headSha: HEAD,
    requiredCoverageComplete,
    parent: { workItemId: PARENT_ID, title: "Nightly review", body: "parent body", issue: parentIssue },
    children,
  });
  return parentIssue;
}

/** The fake's current view of one published issue. */
function issueOf(number: number): FakeIssue {
  const found = rig.scm.recordedIssues().find((i) => i.ref.number === number);
  if (found === undefined) throw new Error(`no issue #${number}`);
  return found;
}

/** A human merges the PR and the branch head becomes the post-merge candidate. */
function mergeAndAdvanceBranch(prNumber: number, postMergeSha: string, content: string | null): void {
  rig.scm.mergePullRequest(REPO, prNumber, fakeSha(`merge-commit-${prNumber}`));
  rig.scm.setBranchHead(REPO, BRANCH, postMergeSha);
  if (content !== null) {
    rig.scm.seedFileContent({ repository: REPO, commitSha: postMergeSha }, FIX_PATH, content);
  }
}

describe("fix lifecycle: repository CI", () => {
  it("uses CI from only the latest PR head", async () => {
    const { child, prNumber, prHeadSha } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    // The repository's CI goes green on the head the PR currently has.
    rig.scm.seedCiEvidence(REPO, prHeadSha, {
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [{ context: "ci/lint", state: "success" }],
    });
    await rig.reconciler.reconcile();

    expect(rig.store.proposal("nfp_finding")).toMatchObject({ ci: "passed", ciHeadSha: prHeadSha });

    // A push moves the PR head. The earlier green run is evidence about a commit
    // nobody is reviewing any more, so it must NOT survive onto the new head.
    const newHead = fakeSha("pr-head-2");
    rig.scm.advancePullRequestHead(REPO, prNumber, newHead);
    await rig.reconciler.reconcile();

    const afterPush = rig.store.proposal("nfp_finding");
    expect(afterPush.pr?.headSha).toBe(newHead);
    expect(afterPush.ci).toBe("unknown");
    expect(afterPush.ciHeadSha).toBeNull();

    // ...and the drop is recorded as a transition, not a silent overwrite.
    expect(rig.store.proposalTransitions.filter((t) => t.axis === "ci").map((t) => [t.from, t.to, t.evidenceSha])).toEqual([
      ["unknown", "passed", prHeadSha],
      ["passed", "unknown", newHead],
    ]);

    // CI for the CURRENT head is what gets recorded, whatever the old head said.
    rig.scm.seedCiEvidence(REPO, newHead, {
      checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
      statuses: [],
    });
    await rig.reconciler.reconcile();
    expect(rig.store.proposal("nfp_finding")).toMatchObject({ ci: "failed", ciHeadSha: newHead });

    // Green CI never resolved anything on its own.
    expect(rig.store.child("nwi_finding").resolution).toBe("open");
  });

  it("records a failing run even while another job is still pending — failure beats pending", async () => {
    const { child, prHeadSha } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    rig.scm.seedCiEvidence(REPO, prHeadSha, {
      checkRuns: [
        { name: "build", status: "completed", conclusion: "failure" },
        { name: "e2e", status: "in_progress", conclusion: null },
      ],
      statuses: [],
    });
    await rig.reconciler.reconcile();

    expect(rig.store.proposal("nfp_finding")).toMatchObject({ ci: "failed", ciHeadSha: prHeadSha });
  });
});

describe("fix lifecycle: merge and post-merge verification", () => {
  it("requires post-merge verification", async () => {
    const { child, prNumber, prHeadSha } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    rig.scm.seedCiEvidence(REPO, prHeadSha, {
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [],
    });

    // A human merges it. The post-merge branch head is not readable yet, so there
    // is nothing to verify against.
    rig.scm.mergePullRequest(REPO, prNumber, fakeSha("merge-commit"));
    await rig.reconciler.reconcile();

    expect(rig.store.proposal("nfp_finding").merge).toBe("merged");
    // MERGE IS NOT RESOLUTION. Green CI plus a human merge gets exactly this far.
    expect(rig.store.child("nwi_finding").resolution).toBe("awaiting_verification");
    expect(rig.store.verifications("nfo_finding")).toEqual([]);
    expect(issueOf(child.issue!.number).state).toBe("open");
    expect(rig.store.parentResolution(PARENT_ID)).toBe("open");

    // The post-merge candidate appears and it no longer contains the reviewed
    // original text — the patch demonstrably landed.
    const postMerge = fakeSha("post-merge-1");
    rig.scm.setBranchHead(REPO, BRANCH, postMerge);
    rig.scm.seedFileContent({ repository: REPO, commitSha: postMerge }, FIX_PATH, PATCHED);
    await rig.reconciler.reconcile();

    const verification = rig.store.verifications("nfo_finding").at(-1);
    expect(verification).toMatchObject({ outcome: "resolved", subjectSha: postMerge, verifierId: "patch-applied-verifier-1" });
    expect(rig.store.child("nwi_finding").resolution).toBe("resolved");
    // Only NOW does the child issue close, and as completed rather than not-planned.
    const closed = issueOf(child.issue!.number);
    expect(closed.state).toBe("closed");
    expect(closed.input.stateReason).toBe("completed");
    expect(rig.store.workItemTransitions).toContainEqual(
      expect.objectContaining({ workItemId: "nwi_finding", from: "awaiting_verification", to: "resolved" }),
    );
  });

  it("keeps the child open when post-merge verification is indeterminate", async () => {
    const { child, prNumber } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    // The branch head exists but the touched path cannot be read there. "Could not
    // tell" must never round to "the defect is gone".
    mergeAndAdvanceBranch(prNumber, fakeSha("post-merge-unreadable"), null);
    await rig.reconciler.reconcile();

    expect(rig.store.verifications("nfo_finding").at(-1)).toMatchObject({ outcome: "indeterminate" });
    expect(rig.store.child("nwi_finding").resolution).toBe("awaiting_verification");
    expect(issueOf(child.issue!.number).state).toBe("open");
    expect(rig.store.parentResolution(PARENT_ID)).toBe("open");
  });

  it("reopens nothing but reports the truth when the merged patch did not clear the finding", async () => {
    const { child, prNumber } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    // Merged, but the reviewed original text is still there at the post-merge head.
    mergeAndAdvanceBranch(prNumber, fakeSha("post-merge-unfixed"), VULNERABLE);
    await rig.reconciler.reconcile();

    expect(rig.store.verifications("nfo_finding").at(-1)).toMatchObject({ outcome: "still_present" });
    expect(rig.store.child("nwi_finding").resolution).toBe("open");
    expect(issueOf(child.issue!.number).state).toBe("open");
    expect(issueOf(child.issue!.number).input.body).toContain("still_present");
  });

  it("does not re-run a verification already recorded for the same immutable head", async () => {
    const { child, prNumber } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    const postMerge = fakeSha("post-merge-stable");
    mergeAndAdvanceBranch(prNumber, postMerge, PATCHED);

    const first = await rig.reconciler.reconcile();
    const second = await rig.reconciler.reconcile();

    expect(first.verificationsRecorded).toBe(1);
    // Crash-resume and steady state look identical: one verification per subject sha.
    expect(second.verificationsRecorded).toBe(0);
    expect(rig.store.verifications("nfo_finding")).toHaveLength(1);
  });
});

describe("fix lifecycle: human actions", () => {
  it("records a manual issue closure as an external dismissal, never as verified", async () => {
    const { child } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    rig.scm.closeIssue(child.issue!.number, { actor: "maintainer", stateReason: "not_planned" });
    await rig.reconciler.reconcile();

    const settled = rig.store.child("nwi_finding");
    expect(settled.resolution).toBe("dismissed");
    expect(settled.dismissal).toMatchObject({ actor: "maintainer", stateReason: "not_planned" });
    // Nothing verified anything; the audit trail must say so.
    expect(rig.store.verifications("nfo_finding")).toEqual([]);
    const body = issueOf(child.issue!.number).input.body;
    expect(body).toContain("Externally dismissed by `maintainer`");
    expect(body).not.toContain("verified resolved");
    expect(rig.store.workItemTransitions).toContainEqual(
      expect.objectContaining({ workItemId: "nwi_finding", to: "dismissed", reason: expect.stringContaining("maintainer") }),
    );
  });

  it("does not relabel Scruffy's own verified closure as a human dismissal on a later tick", async () => {
    const { child, prNumber } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    mergeAndAdvanceBranch(prNumber, fakeSha("post-merge-clean"), PATCHED);
    await rig.reconciler.reconcile();
    expect(rig.store.child("nwi_finding").resolution).toBe("resolved");

    // The issue is closed now — by Scruffy. Re-reading that closure must not turn a
    // verified resolution into somebody's dismissal.
    await rig.reconciler.reconcile();
    expect(rig.store.child("nwi_finding")).toMatchObject({ resolution: "resolved", dismissal: null });
  });

  it("records a human closing the PR unmerged without resolving the finding", async () => {
    const { child, prNumber } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    rig.scm.closePullRequest(REPO, prNumber);
    await rig.reconciler.reconcile();

    expect(rig.store.proposal("nfp_finding").merge).toBe("closed_unmerged");
    expect(rig.store.child("nwi_finding").resolution).toBe("open");
    expect(rig.store.parentResolution(PARENT_ID)).toBe("open");
  });
});

describe("fix lifecycle: parent closure", () => {
  it("closes parent only after every child is terminal", async () => {
    const verified = await seedFindingChild({
      workItemId: "nwi_verified",
      occurrenceId: "nfo_verified",
      proposalId: "nfp_verified",
    });
    const dismissed = await seedFindingChild({
      workItemId: "nwi_dismissed",
      occurrenceId: "nfo_dismissed",
      proposalId: "nfp_dismissed",
      draft: true,
    });
    const open = await seedFindingChild({
      workItemId: "nwi_open",
      occurrenceId: "nfo_open",
      proposalId: "nfp_open",
    });
    const parentIssue = await seedReport([verified.child, dismissed.child, open.child]);

    // One child merged and verified, one closed by a human, one still open.
    mergeAndAdvanceBranch(verified.prNumber, fakeSha("post-merge-verified"), PATCHED);
    rig.scm.closeIssue(dismissed.child.issue!.number, { actor: "maintainer", stateReason: "not_planned" });

    const first = await rig.reconciler.reconcile();

    expect(rig.store.child("nwi_verified").resolution).toBe("resolved");
    expect(rig.store.child("nwi_dismissed").resolution).toBe("dismissed");
    expect(rig.store.child("nwi_open").resolution).toBe("open");
    expect(first.parentsClosed).toBe(0);
    expect(rig.store.parentResolution(PARENT_ID)).toBe("open");
    expect(issueOf(parentIssue.number).state).toBe("open");
    // The parent says exactly what it is waiting on, not just "still open".
    expect(issueOf(parentIssue.number).input.body).toContain("nwi_open is open");

    // The last child becomes terminal.
    rig.scm.closeIssue(open.child.issue!.number, { actor: "maintainer", stateReason: "completed" });
    const second = await rig.reconciler.reconcile();

    expect(second.parentsClosed).toBe(1);
    expect(rig.store.parentResolution(PARENT_ID)).toBe("resolved");
    expect(issueOf(parentIssue.number).state).toBe("closed");
    expect(issueOf(parentIssue.number).input.body).toContain("All child items are resolved or dismissed");

    // A settled parent is not reconciled again, and nothing reopens.
    const third = await rig.reconciler.reconcile();
    expect(third.parentsClosed).toBe(0);
    expect(issueOf(parentIssue.number).state).toBe("closed");
  });

  it("holds the parent open while required coverage is incomplete, even with every child terminal", async () => {
    const verified = await seedFindingChild({
      workItemId: "nwi_verified",
      occurrenceId: "nfo_verified",
      proposalId: "nfp_verified",
    });
    const gap: SeedChild = {
      workItemId: "nwi_gap",
      kind: "coverage_gap",
      title: "Coverage gap: model-analyzer",
      body: "the model analyzer did not run",
      occurrenceId: null,
      issue: await publishIssue("nwi_gap", "Coverage gap: model-analyzer", "the model analyzer did not run", [
        "scruffy",
        "scruffy:coverage-gap",
      ]),
    };
    const parentIssue = await seedReport([verified.child, gap], false);

    mergeAndAdvanceBranch(verified.prNumber, fakeSha("post-merge-verified"), PATCHED);
    rig.scm.closeIssue(gap.issue!.number, { actor: "maintainer", stateReason: "not_planned" });

    await rig.reconciler.reconcile();

    expect(rig.store.child("nwi_verified").resolution).toBe("resolved");
    // A coverage gap has no occurrence and no proposal: a human dismissal is its
    // only terminal path, and it must not be quietly counted as "resolved".
    expect(rig.store.child("nwi_gap").resolution).toBe("dismissed");
    expect(rig.store.parentResolution(PARENT_ID)).toBe("open");
    expect(issueOf(parentIssue.number).input.body).toContain("required analyzer coverage is incomplete");
  });

  it("keeps the parent open while a child's fix delivery failed", async () => {
    const { child } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);

    // A delivered proposal cannot be downgraded to failed — the PR exists.
    expect(await rig.store.recordDeliveryFailure("nfp_finding", "branch collision")).toBe(false);
    expect(rig.store.proposal("nfp_finding").delivery).toBe("ready_open");

    await rig.reconciler.reconcile();
    expect(rig.store.parentResolution(PARENT_ID)).toBe("open");
  });
});

describe("fix lifecycle: idempotency", () => {
  it("converges on the same durable state across repeated passes", async () => {
    const { child, prHeadSha } = await seedFindingChild({
      workItemId: "nwi_finding",
      occurrenceId: "nfo_finding",
      proposalId: "nfp_finding",
    });
    await seedReport([child]);
    rig.scm.seedCiEvidence(REPO, prHeadSha, {
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [],
    });

    await rig.reconciler.reconcile();
    const transitionsAfterFirst = rig.store.proposalTransitions.length;
    const resolutionsAfterFirst = rig.store.workItemTransitions.length;

    await rig.reconciler.reconcile();
    await rig.reconciler.reconcile();

    // Nothing changed provider-side, so no axis moved and nothing was re-appended.
    expect(rig.store.proposalTransitions).toHaveLength(transitionsAfterFirst);
    expect(rig.store.workItemTransitions).toHaveLength(resolutionsAfterFirst);
    // One issue per work item, however many times the body was refreshed.
    expect(rig.scm.recordedIssues()).toHaveLength(2);
    expect(rig.scm.recordedCheckRuns()).toHaveLength(1);
  });
});
