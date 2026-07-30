import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { FixReconciler } from "../../src/app/fix-reconciler.js";
import { PatchAppliedVerifier } from "../../src/gates/nightly/verify.js";
import { FakeScm, fakeSha } from "../../src/providers/scm/fake.js";
import { fixProposalExternalId } from "../../src/domain/fixes/delivery.js";
import { workItemIssueMarker, type IssueExternalRef } from "../../src/domain/findings/work-publication.js";
import { MemoryFixLifecycleStore, type SeedChild } from "../support/memory-fix-lifecycle.js";
import type { FakeIssue } from "../../src/providers/scm/fake.js";
import { describeDb } from "../support/db.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { RunStore } from "../../src/persistence/runs.js";
import { PublicationStore } from "../../src/persistence/publications.js";
import { FixLifecycleStore } from "../../src/persistence/fix-lifecycle.js";
import { COMPLETE_COVERAGE } from "../../src/domain/evidence/coverage.js";
import type { Finding } from "../../src/domain/evidence/types.js";
import type { NightlyPolicy } from "../../src/domain/policy/types.js";
import { dedupeFindings } from "../../src/domain/findings/identity.js";
import { planNightlyWorkGraph } from "../../src/domain/findings/work-graph.js";
import { NIGHTLY_REPORT_SCHEMA_VERSION, type NightlyReportIdentity } from "../../src/domain/findings/work-identity.js";
import { evaluateNightly } from "../../src/gates/nightly/decision.js";
import { generateFixes } from "../../src/gates/nightly/fix.js";
import { buildNightlyReport } from "../../src/gates/nightly/report.js";
import { TlsFixer } from "../../src/providers/fixers/tls-fixer.js";

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

/**
 * The same lifecycle, but against real SQL and across a process boundary.
 *
 * Everything above runs on an in-memory port, which proves the DERIVATIONS. This
 * suite proves the part that memory cannot: that a restarted Scruffy still knows
 * which pull request belongs to which finding, which commit a CI verdict was read
 * at, that a human merged, and what a post-merge verification concluded. If any
 * of that lived only in a process, a crash would silently re-open PRs, re-verify
 * settled findings, or — worse — lose the PR and report the finding as unfixed
 * while the fix sits open on GitHub.
 */

const dbPool = createPool();

afterAll(async () => {
  await dbPool.end();
});

const DB_REPO = "acme/web";
const DB_HEAD = "b".repeat(40);
const DB_POLICY: NightlyPolicy = {
  reportableDefectClasses: ["disabled-tls-verification"],
  fixableDefectClasses: ["disabled-tls-verification"],
};
const PR_HEAD_1 = "c".repeat(40);
const PR_HEAD_2 = "d".repeat(40);
const MERGE_SHA = "e".repeat(40);
const POST_MERGE_SHA = fakeSha("post-merge-head");

const DB_IDENTITY: NightlyReportIdentity = {
  repository: DB_REPO,
  branch: BRANCH,
  baseSha: null,
  headSha: DB_HEAD,
  policyVersion: "policy-v1",
  schemaVersion: NIGHTLY_REPORT_SCHEMA_VERSION,
};

function tlsFinding(): Finding {
  return {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    subject: { repository: DB_REPO, commitSha: DB_HEAD },
    primaryRegion: { path: FIX_PATH, startLine: 3, endLine: 3, snippet: "rejectUnauthorized: false" },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "disables TLS verification" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
  };
}

describeDb("fix lifecycle durability (Postgres)", () => {
  let dbClock: FixedClock;

  beforeEach(async () => {
    await migrate(dbPool);
    await dbPool.query(
      `truncate nightly_finding_verifications, nightly_fix_proposal_transitions,
                nightly_work_item_transitions, nightly_work_item_publications,
                nightly_fix_proposals, nightly_work_items, nightly_report_findings,
                nightly_reports, outbox_dependencies, outbox, nightly_decisions,
                review_watermarks, run_transitions, evaluation_runs cascade`,
    );
    dbClock = new FixedClock(new Date("2026-07-30T02:00:00.000Z"));
  });

  it("keeps external references and transitions across a restart", async () => {
    // ── Process 1: review, publish, deliver, observe ──────────────────────────
    const runs = new RunStore(dbPool, dbClock, new SeededIdGenerator("fix-lifecycle"));
    const findings = dedupeFindings([tlsFinding()]);
    const { decision, fixes } = generateFixes(findings, evaluateNightly(findings, DB_POLICY, COMPLETE_COVERAGE), {
      "disabled-tls-verification": new TlsFixer(),
    });
    const report = buildNightlyReport({ identity: DB_IDENTITY, findings, decision, fixes });
    const workGraph = planNightlyWorkGraph(report);

    const run = await runs.ensureNightlyRun({ repository: DB_REPO, commitSha: DB_HEAD }, BRANCH, null, "policy-v1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 60_000);
    expect(
      await runs.commitNightlyDecision({
        runId: run.id,
        from: "analyzing",
        to: "decided",
        reason: "nightly decided",
        report,
        workGraph,
        decision,
        findings,
        effects: [],
        fenceLease: lease!,
      }),
    ).toBe(true);

    const seeded = await dbPool.query<{ proposal_id: string; occurrence_id: string; work_item_id: string }>(
      "select proposal_id, occurrence_id, work_item_id from nightly_fix_proposals",
    );
    const { proposal_id: proposalId, occurrence_id: occurrenceId, work_item_id: childId } = seeded.rows[0]!;
    expect(childId).not.toBeNull();
    const parentId = (
      await dbPool.query<{ work_item_id: string }>("select work_item_id from nightly_work_items where kind = 'nightly_run'")
    ).rows[0]!.work_item_id;

    // The issues GitHub gave back, and the PR the writer opened.
    const publications = new PublicationStore(dbPool, dbClock);
    await publications.recordIssue(parentId, workItemIssueMarker(parentId), {
      provider: "github",
      number: 700,
      externalId: "I_parent",
      url: `https://github.com/${DB_REPO}/issues/700`,
    });
    await publications.recordIssue(childId!, workItemIssueMarker(childId!), {
      provider: "github",
      number: 701,
      externalId: "I_child",
      url: `https://github.com/${DB_REPO}/issues/701`,
    });

    const before = new FixLifecycleStore(dbPool, dbClock);
    const pr = { number: 4242, url: `https://github.com/${DB_REPO}/pull/4242`, headSha: PR_HEAD_1, draft: false };
    await before.recordDeliveryResult({ proposalId, delivery: "ready_open", pr });
    // Green at the first head...
    await before.recordObservation({
      proposalId,
      delivery: "ready_open",
      ci: "passed",
      ciHeadSha: PR_HEAD_1,
      merge: "open",
      pr,
      mergeCommitSha: null,
    });
    // ...then the author pushes, and nothing is known about the new head yet.
    const pushed = { ...pr, headSha: PR_HEAD_2 };
    await before.recordObservation({
      proposalId,
      delivery: "ready_open",
      ci: "unknown",
      ciHeadSha: null,
      merge: "open",
      pr: pushed,
      mergeCommitSha: null,
    });
    // A human merges it, and the first post-merge look cannot tell.
    await before.recordObservation({
      proposalId,
      delivery: "ready_open",
      ci: "passed",
      ciHeadSha: PR_HEAD_2,
      merge: "merged",
      pr: pushed,
      mergeCommitSha: MERGE_SHA,
    });
    await before.setResolution({
      occurrenceId,
      workItemId: childId,
      resolution: "awaiting_verification",
      reason: "merged — awaiting post-merge verification",
    });
    await before.recordVerification(occurrenceId, {
      outcome: "indeterminate",
      detail: "could not read src/http.ts at the post-merge head",
      subjectSha: POST_MERGE_SHA,
      verifierId: "patch-applied-verifier-1",
    });

    // ── Process 2: nothing in memory, everything from the database ────────────
    const after = new FixLifecycleStore(dbPool, new FixedClock(new Date("2026-07-30T03:00:00.000Z")));

    const [record] = await after.proposalsToReconcile(10);
    expect(record).toBeDefined();
    // The provider handles: which PR this finding's patch actually lives in.
    expect(record!.pr).toEqual({ number: 4242, url: `https://github.com/${DB_REPO}/pull/4242`, headSha: PR_HEAD_2, draft: false });
    expect(record!.merge).toBe("merged");
    expect(record!.mergeCommitSha).toBe(MERGE_SHA);
    // The CI verdict is inseparable from the commit it was read on.
    expect(record!.ci).toBe("passed");
    expect(record!.ciHeadSha).toBe(PR_HEAD_2);
    // And the delivery identity: the reviewed candidate and the branch it targets
    // are read back, never recomputed from something that may have moved.
    expect(record!.repository).toBe(DB_REPO);
    expect(record!.baseBranch).toBe(BRANCH);
    expect(record!.reviewedHeadSha).toBe(DB_HEAD);
    expect(record!.branch).toContain(DB_HEAD.slice(0, 12));
    expect(record!.edits[0]).toMatchObject({ path: FIX_PATH, expectedOriginal: expect.stringContaining("rejectUnauthorized") });

    // The verification is keyed to its immutable subject sha and to nothing else:
    // a restart must not let an answer about one commit stand in for another.
    expect(await after.getVerification(occurrenceId, POST_MERGE_SHA)).toMatchObject({ outcome: "indeterminate" });
    expect(await after.getVerification(occurrenceId, "f".repeat(40))).toBeNull();

    // Every axis transition is on record, in order, each naming its evidence.
    const transitions = await dbPool.query<{ axis: string; from_state: string | null; to_state: string; evidence_sha: string | null }>(
      "select axis, from_state, to_state, evidence_sha from nightly_fix_proposal_transitions where proposal_id = $1 order by seq",
      [proposalId],
    );
    expect(transitions.rows).toEqual([
      { axis: "delivery", from_state: null, to_state: "ready_open", evidence_sha: null },
      { axis: "ci", from_state: "unknown", to_state: "passed", evidence_sha: PR_HEAD_1 },
      // The push: same PR, new head, and the green result explicitly did not follow it.
      { axis: "ci", from_state: "passed", to_state: "unknown", evidence_sha: PR_HEAD_2 },
      { axis: "ci", from_state: "unknown", to_state: "passed", evidence_sha: PR_HEAD_2 },
      { axis: "merge", from_state: "open", to_state: "merged", evidence_sha: MERGE_SHA },
    ]);
    const workItemTransitions = await dbPool.query<{ from_state: string | null; to_state: string }>(
      "select from_state, to_state from nightly_work_item_transitions where work_item_id = $1 and axis = 'resolution' order by seq",
      [childId],
    );
    expect(workItemTransitions.rows.at(-1)).toEqual({ from_state: "open", to_state: "awaiting_verification" });

    // The closure view a restarted reconciler reads: parent still open, its issue
    // reference intact, the child merged-but-unverified rather than resolved.
    const [view] = await after.openReports(10);
    expect(view!.parent).toMatchObject({ workItemId: parentId, issue: { number: 700, externalId: "I_parent" } });
    expect(view!.requiredCoverageComplete).toBe(true);
    const child = view!.children.find((c) => c.workItemId === childId)!;
    expect(child.issue).toMatchObject({ number: 701, externalId: "I_child" });
    expect(child.resolution).toBe("awaiting_verification");
    expect(child.proposal).toMatchObject({ proposalId, delivery: "ready_open", ci: "passed", merge: "merged", pr: { number: 4242 } });
    expect(child.verification).toMatchObject({ outcome: "indeterminate", subjectSha: POST_MERGE_SHA });
    expect(child.dismissal).toBeNull();

    // Finally: a human's dismissal of a DIFFERENT-looking outcome survives too, and
    // survives as a dismissal — the actor and reason GitHub gave, not a verification.
    await after.recordDismissal(childId!, { actor: "octocat", stateReason: "not_planned", at: new Date("2026-07-30T04:00:00.000Z") });
    await after.setResolution({ occurrenceId, workItemId: childId, resolution: "dismissed", reason: "closed on GitHub" });
    const restarted = new FixLifecycleStore(dbPool, dbClock);
    const dismissedChild = (await restarted.openReports(10))[0]!.children.find((c) => c.workItemId === childId)!;
    expect(dismissedChild.dismissal).toMatchObject({ actor: "octocat", stateReason: "not_planned" });
    expect(dismissedChild.resolution).toBe("dismissed");
    // A terminal finding drops out of reconciliation instead of being re-polled forever.
    expect(await restarted.proposalsToReconcile(10)).toHaveLength(0);
  });
});
