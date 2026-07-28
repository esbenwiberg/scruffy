import type { EffectDependency, EffectProduction, IssueExternalRef, NightlyPublicationState } from "../../src/domain/findings/work-publication.js";
import { NightlyPublicationState as NightlyPublicationStateSchema, workItemIssueMarker } from "../../src/domain/findings/work-publication.js";
import type { NightlyWorkGraph } from "../../src/domain/findings/work-graph.js";
import type { OutboxPort, OutboxRecord } from "../../src/persistence/outbox.js";
import type { NightlyPublicationPort } from "../../src/persistence/publications.js";

/**
 * In-memory `OutboxPort` + `NightlyPublicationPort` for effects tests.
 *
 * WHY DOUBLES. The DB-backed suites are the authority on the SQL (claim predicate,
 * upsert keys, constraint guards). These doubles exist so the effects component's
 * BEHAVIOUR — that a dependent effect is never claimed before its references exist,
 * that a write result survives a retry, that a terminal dependency failure cascades
 * — is provable on every `npm test` run, including on a machine with no Postgres
 * where the DB suites are skipped and would otherwise prove nothing.
 *
 * They re-implement the same predicates as the production stores, because those
 * predicates are exactly what the tests are about.
 */

type Status = "pending" | "processing" | "sent" | "failed";

interface Row {
  id: string;
  runId: string;
  effectType: string;
  externalId: string;
  payload: unknown;
  attempts: number;
  status: Status;
  lastError: string | null;
  produces: EffectProduction | null;
  dependsOn: readonly EffectDependency[];
}

interface PublicationRecord {
  workItemId: string;
  marker: string;
  issue: IssueExternalRef | null;
  attachedToParent: boolean;
  publicationError: string | null;
  attachmentError: string | null;
}

export class MemoryOutbox implements OutboxPort {
  readonly rows: Row[] = [];
  #seq = 0;

  constructor(private readonly publications: MemoryPublications) {}

  enqueue(effect: {
    effectType: string;
    externalId: string;
    payload: unknown;
    produces?: EffectProduction;
    dependsOn?: readonly EffectDependency[];
  }): string {
    // Same key as the SQL `unique (run_id, external_id)`: a re-commit reuses the row.
    const existing = this.rows.find((r) => r.externalId === effect.externalId);
    if (existing) return existing.id;
    this.#seq += 1;
    const id = `obx_${this.#seq}`;
    this.rows.push({
      id,
      runId: "run_1",
      effectType: effect.effectType,
      externalId: effect.externalId,
      payload: effect.payload,
      attempts: 0,
      status: "pending",
      lastError: null,
      produces: effect.produces ?? null,
      dependsOn: effect.dependsOn ?? [],
    });
    return id;
  }

  /** Mirrors `UNSATISFIED_DEPENDENCY` in `src/persistence/outbox.ts`. */
  #blocked(row: Row): boolean {
    return row.dependsOn.some((dependency) => {
      const record = this.publications.record(dependency.workItemId);
      switch (dependency.requires) {
        case "issue_reference":
          return record?.issue == null;
        case "publication_settled":
          return record?.issue == null && record?.publicationError == null;
        case "attachment_settled":
          return record?.attachedToParent !== true && record?.attachmentError == null && record?.publicationError == null;
        default: {
          const _exhaustive: never = dependency.requires;
          return _exhaustive;
        }
      }
    });
  }

  async claimPending(limit: number): Promise<OutboxRecord[]> {
    const claimable = this.rows.filter((row) => row.status === "pending" && !this.#blocked(row)).slice(0, limit);
    return claimable.map((row) => {
      row.status = "processing";
      row.attempts += 1;
      return {
        id: row.id,
        runId: row.runId,
        effectType: row.effectType,
        externalId: row.externalId,
        payload: row.payload,
        attempts: row.attempts,
        produces: row.produces,
      };
    });
  }

  async markSent(id: string): Promise<void> {
    const row = this.#processing(id);
    if (row) row.status = "sent";
  }

  async release(id: string): Promise<void> {
    const row = this.#processing(id);
    if (row) row.status = "pending";
  }

  async markFailed(id: string, error: string): Promise<void> {
    const row = this.#processing(id);
    if (row) {
      row.status = "failed";
      row.lastError = error;
    }
  }

  async failDependentsAwaitingReference(workItemId: string, error: string): Promise<EffectProduction[]> {
    const orphaned: EffectProduction[] = [];
    for (const row of this.rows) {
      if (row.status !== "pending" && row.status !== "processing") continue;
      if (!row.dependsOn.some((d) => d.workItemId === workItemId && d.requires === "issue_reference")) continue;
      row.status = "failed";
      row.lastError = `dependency ${workItemId} will never be published: ${error}`;
      if (row.produces !== null) orphaned.push(row.produces);
    }
    return orphaned;
  }

  /** Pending rows that cannot be claimed yet because a dependency is unsatisfied. */
  blocked(): Row[] {
    return this.rows.filter((row) => row.status === "pending" && this.#blocked(row));
  }

  byStatus(status: Status): Row[] {
    return this.rows.filter((row) => row.status === status);
  }

  #processing(id: string): Row | undefined {
    // The production store settles only rows still in `processing`.
    return this.rows.find((row) => row.id === id && row.status === "processing");
  }
}

export class MemoryPublications implements NightlyPublicationPort {
  readonly #records = new Map<string, PublicationRecord>();
  /** Work items by report, so `publicationState` can render unattempted items too. */
  readonly #graph = new Map<string, { workItemId: string; kind: NightlyWorkGraph["children"][number]["kind"]; title: string }[]>();

  /** Seed the durable work graph the way `commitNightlyDecision` would have. */
  seedGraph(reportId: string, graph: NightlyWorkGraph): void {
    const items = graph.parent === null ? [] : [graph.parent, ...graph.children];
    this.#graph.set(
      reportId,
      items.map((item) => ({ workItemId: item.workItemId, kind: item.kind, title: item.title })),
    );
  }

  record(workItemId: string): PublicationRecord | undefined {
    return this.#records.get(workItemId);
  }

  async getIssueRef(workItemId: string): Promise<IssueExternalRef | null> {
    return this.#records.get(workItemId)?.issue ?? null;
  }

  async recordIssue(workItemId: string, marker: string, ref: IssueExternalRef): Promise<void> {
    const existing = this.#upsert(workItemId, marker);
    existing.issue = ref;
    existing.publicationError = null;
  }

  async recordPublicationFailure(workItemId: string, reason: string): Promise<void> {
    const existing = this.#upsert(workItemId, workItemIssueMarker(workItemId));
    // Guarded like the SQL: a published item is never downgraded to "could not be filed".
    if (existing.issue !== null) return;
    existing.publicationError = reason;
  }

  async recordAttachment(workItemId: string): Promise<void> {
    const existing = this.#records.get(workItemId);
    if (!existing || existing.issue === null) return;
    existing.attachedToParent = true;
    existing.attachmentError = null;
  }

  async recordAttachmentFailure(workItemId: string, reason: string): Promise<void> {
    const existing = this.#records.get(workItemId);
    if (!existing || existing.attachedToParent) return;
    existing.attachmentError = reason;
  }

  async publicationState(reportId: string): Promise<NightlyPublicationState | null> {
    const items = this.#graph.get(reportId);
    if (!items || items.length === 0) return null;
    const mapped = items.map((item) => {
      const record = this.#records.get(item.workItemId);
      return {
        workItemId: item.workItemId,
        kind: item.kind,
        title: item.title,
        marker: record?.marker ?? workItemIssueMarker(item.workItemId),
        issue: record?.issue ?? null,
        attachedToParent: record?.attachedToParent ?? false,
        publicationError: record?.publicationError ?? null,
        attachmentError: record?.attachmentError ?? null,
      };
    });
    return NightlyPublicationStateSchema.parse({
      reportId,
      parent: mapped.find((item) => item.kind === "nightly_run") ?? null,
      children: mapped.filter((item) => item.kind !== "nightly_run"),
    });
  }

  #upsert(workItemId: string, marker: string): PublicationRecord {
    const existing = this.#records.get(workItemId);
    if (existing) return existing;
    const created: PublicationRecord = {
      workItemId,
      marker,
      issue: null,
      attachedToParent: false,
      publicationError: null,
      attachmentError: null,
    };
    this.#records.set(workItemId, created);
    return created;
  }
}
