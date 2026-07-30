import { NIGHTLY_CHECK_NAME, nightlyCheckExternalId } from "../effects/check-run.js";
import {
  ciStateForHead,
  deriveDeliveryState,
  deriveFindingResolution,
  deriveMergeState,
  deriveParentClosure,
  isTerminalResolution,
  renderFixLifecycle,
  type ExternalDismissal,
  type FindingVerification,
  type ParentClosure,
} from "../domain/fixes/lifecycle.js";
import {
  renderMorningSummary,
  type MorningSummary,
  type MorningSummaryInput,
} from "../domain/findings/morning-summary.js";
import { issueLabelsFor, workItemIssueMarker } from "../domain/findings/work-publication.js";
import type { FindingResolution } from "../domain/findings/work-graph.js";
import type { PostMergeVerifier } from "../gates/nightly/verify.js";
import type {
  FixDeliveryRecord,
  NightlyFixLifecyclePort,
  ReportChildState,
  ReportClosureView,
} from "../persistence/fix-lifecycle.js";
import type { Clock } from "../platform/clock.js";
import type { ScmLifecycleReader, ScmWriter } from "../providers/scm/port.js";

/**
 * Reconcile the half of the fix lifecycle Scruffy does not control: repository CI,
 * a human merging or closing a PR, a human closing an issue, and what the merged
 * result actually looks like.
 *
 * Two passes, in this order, and the order matters:
 *
 *  1. PROPOSAL pass — read each delivered PR, bind CI evidence to the PR's CURRENT
 *     head, record merge state, and (once merged) verify the finding against the
 *     immutable post-merge branch head. Records evidence only; resolves nothing.
 *  2. REPORT pass — for each open parent, fold that durable evidence together with
 *     any external dismissal into one resolution per child, refresh the child and
 *     parent issue bodies from those rows, and close the parent only when closure
 *     derivation says every child is terminal and coverage is complete.
 *
 * Splitting the passes is what keeps resolution single-sourced. If the proposal
 * pass also resolved findings it would have to guess about dismissals it cannot
 * see, and two writers of one field is how a dismissed child quietly reverts to
 * open on the next tick.
 *
 * EVERYTHING IS IDEMPOTENT AND CRASH-SAFE BY CONSTRUCTION: every write is an
 * upsert or a guarded update keyed on an immutable identity, and every read is of
 * durable state rather than of something remembered from an earlier tick. A crash
 * anywhere re-runs the same derivation and converges on the same rows.
 *
 * NO WRITE HERE CHANGES CODE. Scruffy never merges, never pushes to the fix
 * branch, and never touches branch protection. The only provider writes are issue
 * body/state updates and one advisory check run.
 */

export interface FixReconcilerDeps {
  lifecycle: NightlyFixLifecyclePort;
  /** Read-only provider access: PR state, CI, branch heads, issue state. */
  reader: ScmLifecycleReader;
  /** The narrow effects credential — the only thing allowed to write. */
  writer: ScmWriter;
  verifier: PostMergeVerifier;
  clock: Clock;
  /** Proposals reconciled per pass. Default 50. */
  proposalLimit?: number;
  /** Open parents reconciled per pass. Default 25. */
  reportLimit?: number;
}

export interface FixReconcileResult {
  proposalsObserved: number;
  verificationsRecorded: number;
  dismissalsRecorded: number;
  resolutionsChanged: number;
  parentsClosed: number;
}

const DEFAULT_PROPOSAL_LIMIT = 50;
const DEFAULT_REPORT_LIMIT = 25;

export class FixReconciler {
  constructor(private readonly deps: FixReconcilerDeps) {}

  /** One full pass. Safe to call concurrently with itself and with the gate. */
  async reconcile(): Promise<FixReconcileResult> {
    const result: FixReconcileResult = {
      proposalsObserved: 0,
      verificationsRecorded: 0,
      dismissalsRecorded: 0,
      resolutionsChanged: 0,
      parentsClosed: 0,
    };
    await this.reconcileProposals(result);
    await this.reconcileReports(result);
    return result;
  }

  /**
   * Observe every delivered PR that is not yet settled, and verify the merged ones.
   *
   * The CI rule lives in one line here: evidence is read for `observation.headSha`
   * and passed through `ciStateForHead`, which refuses to reuse a verdict read at
   * any other commit. A force-push between two ticks therefore drops the recorded
   * verdict back to `unknown` for the new head rather than carrying the old green.
   */
  async reconcileProposals(result: FixReconcileResult): Promise<void> {
    const records = await this.deps.lifecycle.proposalsToReconcile(this.deps.proposalLimit ?? DEFAULT_PROPOSAL_LIMIT);
    for (const record of records) {
      if (record.pr === null) continue;
      const observation = await this.deps.reader.getPullRequest(record.repository, record.pr.number);
      // A PR the provider no longer returns (deleted repository, revoked access) is
      // left exactly as it is. Inventing a state for it would either fabricate a
      // merge or erase a real one.
      if (observation === null) continue;

      const evidence = await this.deps.reader.getCiEvidence(record.repository, observation.headSha);
      const ci = ciStateForHead(observation.headSha, evidence);
      const merge = deriveMergeState(observation);

      await this.deps.lifecycle.recordObservation({
        proposalId: record.proposalId,
        delivery: deriveDeliveryState(observation),
        ci: ci.state,
        ciHeadSha: ci.evidenceSha,
        merge,
        pr: {
          number: observation.number,
          url: observation.url,
          headSha: observation.headSha,
          draft: observation.draft,
        },
        mergeCommitSha: observation.mergeCommitSha,
      });
      result.proposalsObserved += 1;

      if (merge === "merged") {
        const verified = await this.#verifyMerged(record);
        if (verified) result.verificationsRecorded += 1;
      }
    }
  }

  /**
   * Verify a merged proposal against the IMMUTABLE post-merge head of the reviewed
   * branch.
   *
   * The subject is re-read every tick rather than pinned to the merge commit,
   * because the question a human cares about is "is the defect present in the
   * branch now", and the branch may have moved on. It is still immutable at the
   * moment of verification: the sha is resolved first and the verifier is only ever
   * given that sha. A verification already on record for exactly this sha is not
   * re-run — that is the crash-resume path, and it also stops an indeterminate
   * verifier from being re-billed on every tick for the same unchanged commit.
   */
  async #verifyMerged(record: FixDeliveryRecord): Promise<boolean> {
    const branch = record.baseBranch;
    if (branch === null) return false;
    const subjectSha = await this.deps.reader.getBranchHead(record.repository, branch);
    // No readable post-merge head means no verification. Deliberately NOT recorded
    // as indeterminate: an absent verification and a verifier that ran and could not
    // tell are different facts, and both already keep the child open.
    if (subjectSha === null) return false;

    const existing = await this.deps.lifecycle.getVerification(record.occurrenceId, subjectSha);
    if (existing !== null) return false;

    const verification = await this.deps.verifier.verify({
      repository: record.repository,
      subjectSha,
      record,
    });
    await this.deps.lifecycle.recordVerification(record.occurrenceId, verification);
    return true;
  }

  /**
   * Fold durable evidence into resolutions, refresh the published issues, and close
   * parents that have earned it.
   */
  async reconcileReports(result: FixReconcileResult): Promise<void> {
    const views = await this.deps.lifecycle.openReports(this.deps.reportLimit ?? DEFAULT_REPORT_LIMIT);
    for (const view of views) {
      if (view.parent === null) continue;
      const settled: ReportChildState[] = [];

      for (const child of view.children) {
        const dismissal = await this.#detectDismissal(view, child, result);
        const resolution = this.#resolutionFor(child, dismissal);

        if (resolution !== child.resolution) {
          await this.deps.lifecycle.setResolution({
            // Null for a coverage-gap child: it has a work item but no finding row,
            // and inventing an occurrence id would silently target nothing.
            occurrenceId: child.occurrenceId,
            workItemId: child.workItemId,
            resolution,
            reason: reasonFor(child, dismissal, resolution),
          });
          result.resolutionsChanged += 1;
        }

        const next: ReportChildState = { ...child, resolution, dismissal };
        settled.push(next);
        await this.#refreshChildIssue(view, next);
      }

      const closure = deriveParentClosure({
        requiredCoverageComplete: view.requiredCoverageComplete,
        children: settled,
      });

      // ONE render, BOTH surfaces. The parent issue body and the advisory check are
      // the operator's two morning views of the same run; deriving them from one
      // value over one persisted view is what makes them congruent by construction
      // rather than by whoever edits them next remembering to change both.
      const morning = renderMorningSummary(morningInput(view, settled, closure));
      await this.#refreshParent(view, morning.body, closure.close);
      await this.#refreshCheck(view, morning);

      if (closure.close) {
        await this.deps.lifecycle.closeParent(
          view.parent.workItemId,
          "required coverage complete and every child item is verified resolved or explicitly dismissed",
        );
        result.parentsClosed += 1;
      }
    }
  }

  /**
   * Was this child closed by a human outside Scruffy?
   *
   * Only asked while the child is NON-TERMINAL. Once Scruffy has resolved a child
   * it closes the issue itself, and re-reading that closure would relabel Scruffy's
   * own verified resolution as a human dismissal — the exact mislabelling the brief
   * forbids. What GitHub gives us (actor, state reason) is stored verbatim; what it
   * withholds stays null rather than being filled in with a plausible guess.
   */
  async #detectDismissal(
    view: ReportClosureView,
    child: ReportChildState,
    result: FixReconcileResult,
  ): Promise<ExternalDismissal | null> {
    if (child.dismissal !== null) return child.dismissal;
    if (child.issue === null) return null;
    if (isTerminalResolution(child.resolution)) return null;

    const state = await this.deps.reader.getIssueState(view.repository, child.issue.number);
    if (state === null || state.state !== "closed") return null;

    const dismissal: ExternalDismissal = {
      actor: state.closedBy,
      stateReason: state.stateReason,
      at: this.deps.clock.now(),
    };
    await this.deps.lifecycle.recordDismissal(child.workItemId, dismissal);
    result.dismissalsRecorded += 1;
    return dismissal;
  }

  #resolutionFor(child: ReportChildState, dismissal: ExternalDismissal | null): FindingResolution {
    // A coverage-gap child has no occurrence and no proposal: nothing can verify it,
    // so a human dismissal is its only terminal path. Passing it through the same
    // derivation keeps that explicit rather than special-casing it into "resolved".
    return deriveFindingResolution({
      merge: child.proposal?.merge ?? null,
      verification: child.verification,
      dismissal,
    });
  }

  /**
   * Re-publish the child issue body from durable state, closing it once terminal.
   *
   * The lifecycle block is APPENDED to the planned body rather than replacing it:
   * the planned half describes the finding (which does not change), the appended
   * half describes what has happened to it since (which does).
   */
  async #refreshChildIssue(view: ReportClosureView, child: ReportChildState): Promise<void> {
    if (child.issue === null) return;
    const lifecycle = renderFixLifecycle({
      delivery: child.proposal?.delivery ?? "queued",
      ci: child.proposal?.ci ?? "unknown",
      ciHeadSha: child.proposal?.ciHeadSha ?? null,
      merge: child.proposal?.merge ?? "open",
      pr: child.proposal?.pr ?? null,
      deliveryError: child.proposal?.deliveryError ?? null,
      verification: child.verification,
      dismissal: child.dismissal,
      resolution: child.resolution,
    });

    await this.deps.writer.upsertIssue({
      repository: view.repository,
      marker: workItemIssueMarker(child.workItemId),
      labels: issueLabelsFor(child.kind),
      title: child.title,
      body: `${child.body}\n\n${lifecycle}`,
      knownRef: { number: child.issue.number, id: child.issue.externalId, url: child.issue.url },
      // Terminal means terminal: closed with GitHub's own distinction between work
      // that was completed and work a human decided not to do. A non-terminal child
      // sends NO state at all — refreshing a body must never reopen an issue whose
      // closure we simply failed to read this tick.
      ...(isTerminalResolution(child.resolution)
        ? ({ state: "closed", stateReason: child.resolution === "resolved" ? "completed" : "not_planned" } as const)
        : {}),
    });
  }

  async #refreshParent(view: ReportClosureView, summary: string, close: boolean): Promise<void> {
    const parent = view.parent;
    if (parent === null || parent.issue === null) return;
    await this.deps.writer.upsertIssue({
      repository: view.repository,
      marker: workItemIssueMarker(parent.workItemId),
      labels: issueLabelsFor("nightly_run"),
      title: parent.title,
      body: `${parent.body}\n\n${summary}`,
      knownRef: { number: parent.issue.number, id: parent.issue.externalId, url: parent.issue.url },
      ...(close ? ({ state: "closed", stateReason: "completed" } as const) : {}),
    });
  }

  /**
   * Re-post the run's advisory check with the CURRENT lifecycle state.
   *
   * Same external id and same candidate as the gate's original post, so this
   * updates one check run rather than adding a competing one. Always `neutral`:
   * nightly checks are shadow/advisory and must never gate a merge. The title and
   * summary are the morning render — the same bytes the parent issue carries.
   */
  async #refreshCheck(view: ReportClosureView, morning: MorningSummary): Promise<void> {
    await this.deps.writer.upsertCheckRun({
      subject: { repository: view.repository, commitSha: view.headSha },
      externalId: nightlyCheckExternalId(view.repository, view.headSha),
      name: NIGHTLY_CHECK_NAME,
      conclusion: "neutral",
      title: morning.title,
      summary: morning.body,
    });
  }
}

/**
 * Project one persisted closure view onto the morning-summary input.
 *
 * Mapping rather than passing the view straight through keeps the renderer free of
 * any persistence type: it takes provider-neutral handles, so a second SCM adapter
 * (or a future non-issue surface) needs no change to it.
 */
function morningInput(view: ReportClosureView, children: readonly ReportChildState[], closure: ParentClosure): MorningSummaryInput {
  return {
    repository: view.repository,
    branch: view.branch,
    headSha: view.headSha,
    baseSha: view.baseSha,
    reportId: view.reportId,
    requiredCoverageComplete: view.requiredCoverageComplete,
    coverage: view.coverage,
    summary: view.summary,
    parent:
      view.parent === null
        ? null
        : {
            workItemId: view.parent.workItemId,
            issue: view.parent.issue === null ? null : { number: view.parent.issue.number, url: view.parent.issue.url },
          },
    children: children.map((child) => ({
      workItemId: child.workItemId,
      kind: child.kind,
      title: child.title,
      resolution: child.resolution,
      issue: child.issue === null ? null : { number: child.issue.number, url: child.issue.url },
      publicationError: child.publicationError,
      remediation: child.remediation,
      proposal:
        child.proposal === null
          ? null
          : {
              delivery: child.proposal.delivery,
              ci: child.proposal.ci,
              ciHeadSha: child.proposal.ciHeadSha,
              merge: child.proposal.merge,
              pr: child.proposal.pr,
              deliveryError: child.proposal.deliveryError,
            },
      verification: child.verification,
      dismissal: child.dismissal,
    })),
    closure,
  };
}

function reasonFor(child: ReportChildState, dismissal: ExternalDismissal | null, resolution: FindingResolution): string {
  switch (resolution) {
    case "resolved":
      return verificationReason(child.verification);
    case "dismissed":
      return `externally dismissed by ${dismissal?.actor ?? "unknown"} (${dismissal?.stateReason ?? "no reason given"})`;
    case "awaiting_verification":
      return child.verification === null
        ? "pull request merged; awaiting post-merge verification"
        : `post-merge verification was indeterminate: ${child.verification.detail}`;
    case "open":
      return child.verification?.outcome === "still_present"
        ? `merged patch did not clear the finding: ${child.verification.detail}`
        : "no terminal evidence yet";
  }
}

function verificationReason(verification: FindingVerification | null): string {
  return verification === null
    ? "verified resolved"
    : `verified resolved at ${verification.subjectSha} by ${verification.verifierId}: ${verification.detail}`;
}
