import type { Clock } from "../../src/platform/clock.js";
import type { ExternalDismissal, FindingVerification } from "../../src/domain/fixes/lifecycle.js";
import type { FindingResolution, NightlyWorkItemKind } from "../../src/domain/findings/work-graph.js";
import type { IssueExternalRef } from "../../src/domain/findings/work-publication.js";
import { FixDeliveryRecord } from "../../src/persistence/fix-lifecycle.js";
import type {
  ChildProposalState,
  NightlyFixLifecyclePort,
  RecordDeliveryInput,
  RecordObservationInput,
  ReportChildState,
  ReportClosureView,
} from "../../src/persistence/fix-lifecycle.js";

/**
 * In-memory `NightlyFixLifecyclePort` for harness tests.
 *
 * WHY A DOUBLE. `FixLifecycleStore` is the authority on the SQL — the pairing
 * constraints, the guarded updates, the seq-unique transition history — and the
 * DB-gated suite proves those against real Postgres. This double exists so the
 * LIFECYCLE BEHAVIOUR the brief is actually about (CI never carried across heads,
 * a merge that only reaches `awaiting_verification`, an indeterminate verification
 * that keeps a child open, a human dismissal that is never relabelled, a parent
 * that closes only when every child is terminal) is proved on every `npm test`
 * run, including in a container with no Postgres where the DB suites are skipped
 * and would otherwise prove nothing at all.
 *
 * It re-implements the SAME GUARDS as the store rather than being a permissive
 * map, because those guards are the behaviour under test:
 *
 *  - `proposalsToReconcile` drops proposals whose finding is already terminal, so
 *    settled work is not re-polled forever;
 *  - a CI transition is appended when the verdict OR its evidence sha changed —
 *    the same verdict on a new head is new evidence, not a no-op;
 *  - `recordDeliveryFailure` refuses to downgrade a proposal that has a PR;
 *  - `getVerification` matches one immutable subject sha exactly, never fuzzily;
 *  - `recordDismissal` records the first external closure and never overwrites it;
 *  - `closeParent` only ever moves an open parent.
 */

export interface ProposalTransition {
  proposalId: string;
  axis: "delivery" | "ci" | "merge";
  from: string | null;
  to: string;
  reason: string;
  evidenceSha: string | null;
  at: Date;
}

export interface WorkItemTransition {
  workItemId: string;
  from: FindingResolution;
  to: FindingResolution;
  reason: string;
  at: Date;
}

/** A child work item as the double holds it, before the joins are applied. */
export interface SeedChild {
  workItemId: string;
  kind: NightlyWorkItemKind;
  title: string;
  body: string;
  occurrenceId: string | null;
  resolution?: FindingResolution;
  issue?: IssueExternalRef | null;
  publicationError?: string | null;
}

export interface SeedReport {
  reportId: string;
  repository: string;
  branch: string;
  headSha: string;
  requiredCoverageComplete: boolean;
  parent: { workItemId: string; title: string; body: string; issue: IssueExternalRef | null };
  children: SeedChild[];
}

/** A proposal as the double holds it: the durable record plus its report link. */
export interface SeedProposal {
  proposalId: string;
  occurrenceId: string;
  reportId: string;
  workItemId: string;
  repository: string;
  baseBranch: string;
  branch: string;
  reviewedHeadSha: string;
  reviewedBaseSha?: string | null;
  defectClass: string;
  ruleId: string;
  path: string;
  edits: FixDeliveryRecord["edits"];
}

interface StoredChild extends SeedChild {
  resolution: FindingResolution;
  issue: IssueExternalRef | null;
  publicationError: string | null;
  dismissal: ExternalDismissal | null;
}

interface StoredReport extends Omit<SeedReport, "children"> {
  children: StoredChild[];
  parentResolution: FindingResolution;
}

type StoredProposal = FixDeliveryRecord & { reportId: string };

export class MemoryFixLifecycleStore implements NightlyFixLifecyclePort {
  readonly #reports: StoredReport[] = [];
  readonly #proposals = new Map<string, StoredProposal>();
  /** occurrence -> subject sha -> verification, in insertion order (newest last). */
  readonly #verifications = new Map<string, Map<string, FindingVerification>>();
  readonly proposalTransitions: ProposalTransition[] = [];
  readonly workItemTransitions: WorkItemTransition[] = [];
  /** Bumped on every mutating write, so tests can assert idempotent no-ops. */
  writes = 0;

  constructor(private readonly clock: Clock) {}

  // ── Seeding (tests only) ───────────────────────────────────────────────────

  seedReport(report: SeedReport): void {
    this.#reports.push({
      ...report,
      parentResolution: "open",
      children: report.children.map((child) => ({
        ...child,
        resolution: child.resolution ?? "open",
        issue: child.issue ?? null,
        publicationError: child.publicationError ?? null,
        dismissal: null,
      })),
    });
  }

  seedProposal(proposal: SeedProposal): void {
    this.#proposals.set(
      proposal.proposalId,
      Object.assign(
        FixDeliveryRecord.parse({
          ...proposal,
          reviewedBaseSha: proposal.reviewedBaseSha ?? null,
          delivery: "queued",
          ci: "unknown",
          ciHeadSha: null,
          merge: "open",
          pr: null,
          deliveryError: null,
          mergeCommitSha: null,
          resolution: "open",
        }),
        { reportId: proposal.reportId },
      ),
    );
  }

  proposal(proposalId: string): StoredProposal {
    const record = this.#proposals.get(proposalId);
    if (record === undefined) throw new Error(`memory-fix-lifecycle: no proposal ${proposalId}`);
    return record;
  }

  child(workItemId: string): StoredChild {
    for (const report of this.#reports) {
      const found = report.children.find((c) => c.workItemId === workItemId);
      if (found !== undefined) return found;
    }
    throw new Error(`memory-fix-lifecycle: no child ${workItemId}`);
  }

  parentResolution(workItemId: string): FindingResolution {
    const report = this.#reports.find((r) => r.parent.workItemId === workItemId);
    if (report === undefined) throw new Error(`memory-fix-lifecycle: no parent ${workItemId}`);
    return report.parentResolution;
  }

  verifications(occurrenceId: string): FindingVerification[] {
    return [...(this.#verifications.get(occurrenceId)?.values() ?? [])];
  }

  // ── Port ───────────────────────────────────────────────────────────────────

  async recordDeliveryResult(input: RecordDeliveryInput): Promise<void> {
    const record = this.proposal(input.proposalId);
    const unchanged =
      record.delivery === input.delivery &&
      record.pr?.number === input.pr.number &&
      record.pr?.headSha === input.pr.headSha &&
      record.pr?.draft === input.pr.draft &&
      record.deliveryError === null;
    if (unchanged) return;
    record.delivery = input.delivery;
    record.pr = { ...input.pr };
    record.deliveryError = null;
    this.writes += 1;
    this.#appendProposalTransition(record.proposalId, "delivery", null, input.delivery, "pull request delivered", null);
  }

  async recordDeliveryFailure(proposalId: string, reason: string): Promise<boolean> {
    const record = this.proposal(proposalId);
    // Guarded exactly like the SQL: a proposal whose PR exists is delivered,
    // whatever a later effect attempt says.
    if (record.pr !== null || record.delivery === "delivery_failed") return false;
    record.delivery = "delivery_failed";
    record.deliveryError = reason;
    this.writes += 1;
    this.#appendProposalTransition(proposalId, "delivery", null, "delivery_failed", reason, null);
    return true;
  }

  async proposalsToReconcile(limit: number): Promise<FixDeliveryRecord[]> {
    return [...this.#proposals.values()]
      .filter((p) => p.pr !== null && this.#resolutionOf(p) !== "resolved" && this.#resolutionOf(p) !== "dismissed")
      .slice(0, limit)
      .map((p) => FixDeliveryRecord.parse({ ...p, resolution: this.#resolutionOf(p) }));
  }

  async recordObservation(input: RecordObservationInput): Promise<void> {
    const record = this.proposal(input.proposalId);
    const before = { delivery: record.delivery, ci: record.ci, ciHeadSha: record.ciHeadSha, merge: record.merge };

    record.delivery = input.delivery;
    record.ci = input.ci;
    record.ciHeadSha = input.ciHeadSha;
    record.merge = input.merge;
    record.pr = { ...input.pr };
    record.mergeCommitSha = input.mergeCommitSha;
    this.writes += 1;

    if (before.delivery !== input.delivery) {
      this.#appendProposalTransition(input.proposalId, "delivery", before.delivery, input.delivery, "observed provider state", null);
    }
    if (before.ci !== input.ci || before.ciHeadSha !== input.ciHeadSha) {
      this.#appendProposalTransition(
        input.proposalId,
        "ci",
        before.ci,
        input.ci,
        input.ciHeadSha === null ? `no evidence for head ${input.pr.headSha}` : `repository CI at ${input.ciHeadSha}`,
        input.ciHeadSha ?? input.pr.headSha,
      );
    }
    if (before.merge !== input.merge) {
      this.#appendProposalTransition(
        input.proposalId,
        "merge",
        before.merge,
        input.merge,
        input.merge === "merged" ? `merged as ${input.mergeCommitSha ?? "unknown commit"}` : "observed provider state",
        input.mergeCommitSha,
      );
    }
  }

  async recordVerification(occurrenceId: string, verification: FindingVerification): Promise<void> {
    const byShas = this.#verifications.get(occurrenceId) ?? new Map<string, FindingVerification>();
    // Re-verifying the same sha replaces in place (same primary key); a NEW sha is
    // appended, and the newest is what the closure view reads.
    byShas.delete(verification.subjectSha);
    byShas.set(verification.subjectSha, verification);
    this.#verifications.set(occurrenceId, byShas);
    this.writes += 1;
  }

  async getVerification(occurrenceId: string, subjectSha: string): Promise<FindingVerification | null> {
    return this.#verifications.get(occurrenceId)?.get(subjectSha) ?? null;
  }

  async recordDismissal(workItemId: string, dismissal: ExternalDismissal): Promise<void> {
    const child = this.child(workItemId);
    if (child.dismissal !== null) return; // first closure wins; never overwritten
    child.dismissal = dismissal;
    this.writes += 1;
  }

  async setResolution(input: {
    occurrenceId: string | null;
    workItemId: string | null;
    resolution: FindingResolution;
    reason: string;
  }): Promise<void> {
    if (input.workItemId === null) return;
    const child = this.child(input.workItemId);
    if (child.resolution === input.resolution) return;
    const from = child.resolution;
    child.resolution = input.resolution;
    this.writes += 1;
    this.workItemTransitions.push({
      workItemId: input.workItemId,
      from,
      to: input.resolution,
      reason: input.reason,
      at: this.clock.now(),
    });
  }

  async openReports(limit: number): Promise<ReportClosureView[]> {
    return this.#reports
      .filter((report) => report.parentResolution === "open")
      .slice(0, limit)
      .map((report) => ({
        reportId: report.reportId,
        repository: report.repository,
        branch: report.branch,
        headSha: report.headSha,
        requiredCoverageComplete: report.requiredCoverageComplete,
        parent: report.parent,
        children: report.children.map((child) => this.#toChildState(child)),
      }));
  }

  async closeParent(workItemId: string, reason: string): Promise<void> {
    const report = this.#reports.find((r) => r.parent.workItemId === workItemId);
    if (report === undefined || report.parentResolution !== "open") return;
    report.parentResolution = "resolved";
    this.writes += 1;
    this.workItemTransitions.push({ workItemId, from: "open", to: "resolved", reason, at: this.clock.now() });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #toChildState(child: StoredChild): ReportChildState {
    const proposal = [...this.#proposals.values()].find((p) => p.workItemId === child.workItemId);
    const state: ChildProposalState | null =
      proposal === undefined
        ? null
        : {
            proposalId: proposal.proposalId,
            delivery: proposal.delivery,
            ci: proposal.ci,
            ciHeadSha: proposal.ciHeadSha,
            merge: proposal.merge,
            pr: proposal.pr === null ? null : { number: proposal.pr.number, url: proposal.pr.url },
            deliveryError: proposal.deliveryError,
          };
    return {
      workItemId: child.workItemId,
      kind: child.kind,
      title: child.title,
      body: child.body,
      resolution: child.resolution,
      deliveryFailed: proposal?.delivery === "delivery_failed",
      publicationFailed: child.publicationError !== null,
      occurrenceId: child.occurrenceId,
      issue: child.issue,
      proposal: state,
      dismissal: child.dismissal,
      // Newest verification wins — each post-merge head is its own subject, and the
      // current answer is never an older, more convenient one.
      verification: child.occurrenceId === null ? null : (this.verifications(child.occurrenceId).at(-1) ?? null),
    };
  }

  /** The finding's resolution, which lives on its child work item. */
  #resolutionOf(proposal: StoredProposal): FindingResolution {
    for (const report of this.#reports) {
      const child = report.children.find((c) => c.workItemId === proposal.workItemId);
      if (child !== undefined) return child.resolution;
    }
    return "open";
  }

  #appendProposalTransition(
    proposalId: string,
    axis: "delivery" | "ci" | "merge",
    from: string | null,
    to: string,
    reason: string,
    evidenceSha: string | null,
  ): void {
    this.proposalTransitions.push({ proposalId, axis, from, to, reason, evidenceSha, at: this.clock.now() });
  }
}
