import type { Clock } from "../platform/clock.js";
import type { NightlyWorkItemKind } from "../domain/findings/work-graph.js";
import {
  IssueExternalRef,
  NightlyPublicationState,
  WorkItemPublication,
  workItemIssueMarker,
} from "../domain/findings/work-publication.js";
import type { Pool } from "./db.js";

/**
 * Durable store for nightly work-item ISSUE PUBLICATION.
 *
 * This is the half the outbox used to throw away: the provider write result. It
 * exists so three things are true at once —
 *
 *  - a child can be attached to a parent created by a previous, crashed pass
 *    (the parent's number is on record, not lost with the process);
 *  - a re-dispatch converges instead of duplicating (the reference is found
 *    locally first, and only then via the provider's marker lookup);
 *  - a TERMINAL failure is durable and human-visible, so a partly published work
 *    graph never renders as a fully published one.
 *
 * Every read parses through the domain schemas: these rows drive an issue body and
 * a check summary, and a half-written reference must fail loudly rather than render
 * as a link to nothing.
 */

/** Row shape for a publication record. */
interface PublicationRow {
  work_item_id: string;
  kind: NightlyWorkItemKind;
  title: string;
  marker: string;
  external_number: number | null;
  external_id: string | null;
  external_url: string | null;
  attached_to_parent: boolean;
  publication_error: string | null;
  attachment_error: string | null;
}

/**
 * What the effects component needs from durable storage to publish a work graph.
 * A port, so the dispatcher is testable against an in-memory double.
 */
export interface NightlyPublicationPort {
  /** The published issue for a work item, or null when it has none yet. */
  getIssueRef(workItemId: string): Promise<IssueExternalRef | null>;
  /** Record a successful publication. Clears any earlier terminal failure. */
  recordIssue(workItemId: string, marker: string, ref: IssueExternalRef): Promise<void>;
  /**
   * Record a TERMINAL publication failure (the effect was dead-lettered).
   *
   * Returns FALSE when the failure was refused because the work item is in fact
   * published. Callers must honour that: a caller that cascades "this reference will
   * never exist" on a `false` would orphan children of a parent issue that exists.
   */
  recordPublicationFailure(workItemId: string, reason: string): Promise<boolean>;
  /** Record that a child is attached under its parent in the provider hierarchy. */
  recordAttachment(workItemId: string): Promise<void>;
  /** Record a TERMINAL attachment failure. */
  recordAttachmentFailure(workItemId: string, reason: string): Promise<void>;
  /** Publication state for a whole report's work graph, for rendering. */
  publicationState(reportId: string): Promise<NightlyPublicationState | null>;
}

export class PublicationStore implements NightlyPublicationPort {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async getIssueRef(workItemId: string): Promise<IssueExternalRef | null> {
    const result = await this.pool.query<Pick<PublicationRow, "external_number" | "external_id" | "external_url">>(
      `select external_number, external_id, external_url
         from nightly_work_item_publications where work_item_id = $1`,
      [workItemId],
    );
    const row = result.rows[0];
    if (!row || row.external_id === null || row.external_number === null || row.external_url === null) return null;
    return IssueExternalRef.parse({
      provider: "github",
      number: row.external_number,
      externalId: row.external_id,
      url: row.external_url,
    });
  }

  /**
   * Idempotent on work_item_id. A retry that reached GitHub twice lands on the same
   * row, and the reference is REWRITTEN from the provider's authoritative answer
   * (a marker-matched update returns the same issue anyway). Any earlier terminal
   * publication error is cleared, because a later success is the truth — and the SQL
   * check constraint refuses to hold both at once.
   */
  async recordIssue(workItemId: string, marker: string, ref: IssueExternalRef): Promise<void> {
    const now = this.clock.now();
    await this.pool.query(
      `insert into nightly_work_item_publications
         (work_item_id, provider, marker, external_number, external_id, external_url,
          publication_error, published_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, null, $7, $7, $7)
       on conflict (work_item_id) do update
         set provider          = excluded.provider,
             marker            = excluded.marker,
             external_number   = excluded.external_number,
             external_id       = excluded.external_id,
             external_url      = excluded.external_url,
             publication_error = null,
             published_at      = coalesce(nightly_work_item_publications.published_at, excluded.published_at),
             updated_at        = excluded.updated_at`,
      [workItemId, ref.provider, marker, ref.number, ref.externalId, ref.url, now],
    );
  }

  /**
   * A terminal publication failure. Guarded on `external_id is null`: an item that
   * WAS published must never be downgraded to "could not be filed" by a later
   * failing effect — the issue exists, and telling a human otherwise sends them
   * looking for something that is right there.
   *
   * Returns whether the failure was actually recorded. FALSE means the guard fired
   * (the item is published), and the caller must NOT treat the reference as
   * unobtainable: cascading from a published parent would dead-letter every child
   * effect and withhold the whole night's findings from humans, with a recorded
   * reason that is untrue. That state is reachable — a `recordIssue` that succeeded
   * followed by a `markSent` that threw leaves the row claimed, and the redundant
   * re-write GitHub then refuses eventually exhausts the retry budget.
   */
  async recordPublicationFailure(workItemId: string, reason: string): Promise<boolean> {
    const now = this.clock.now();
    const result = await this.pool.query(
      `insert into nightly_work_item_publications
         (work_item_id, provider, marker, publication_error, created_at, updated_at)
       values ($1, 'github', $2, $3, $4, $4)
       on conflict (work_item_id) do update
         set publication_error = $3,
             updated_at        = $4
         where nightly_work_item_publications.external_id is null`,
      [workItemId, workItemIssueMarker(workItemId), reason.slice(0, 2000), now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordAttachment(workItemId: string): Promise<void> {
    const now = this.clock.now();
    // Guarded on an existing issue reference: `attached_to_parent` without one
    // violates the table's own constraint, and would claim a hierarchy edge between
    // an issue and nothing.
    await this.pool.query(
      `update nightly_work_item_publications
          set attached_to_parent = true, attachment_error = null, attached_at = coalesce(attached_at, $2), updated_at = $2
        where work_item_id = $1 and external_id is not null`,
      [workItemId, now],
    );
  }

  /**
   * A terminal attachment failure. An UPSERT rather than a bare update, because the
   * commonest way to reach here is a child that was never published at all — a
   * cascade from a failed parent — and that child may have no publication row yet.
   * A bare update would silently store nothing and lose the reason. Guarded on
   * `attached_to_parent = false` so an attached child is never told otherwise.
   */
  async recordAttachmentFailure(workItemId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    await this.pool.query(
      `insert into nightly_work_item_publications
         (work_item_id, provider, marker, attachment_error, created_at, updated_at)
       values ($1, 'github', $2, $3, $4, $4)
       on conflict (work_item_id) do update
         set attachment_error = $3,
             updated_at       = $4
         where nightly_work_item_publications.attached_to_parent = false`,
      [workItemId, workItemIssueMarker(workItemId), reason.slice(0, 2000), now],
    );
  }

  /**
   * Publication state for a report: the parent first, then children in stable
   * work-item-id order. Work items with no publication row yet are included as
   * unattempted — the caller must be able to distinguish "not filed yet" from
   * "could not be filed", and omitting them would collapse the two.
   */
  async publicationState(reportId: string): Promise<NightlyPublicationState | null> {
    const result = await this.pool.query<PublicationRow>(
      `select w.work_item_id,
              w.kind,
              w.title,
              coalesce(p.marker, '') as marker,
              p.external_number,
              p.external_id,
              p.external_url,
              coalesce(p.attached_to_parent, false) as attached_to_parent,
              p.publication_error,
              p.attachment_error
         from nightly_work_items w
         left join nightly_work_item_publications p on p.work_item_id = w.work_item_id
        where w.report_id = $1
        order by (w.kind = 'nightly_run') desc, w.work_item_id`,
      [reportId],
    );
    if (result.rows.length === 0) return null;

    const items = result.rows.map((row) => toPublication(row));
    const parent = items.find((item) => item.kind === "nightly_run") ?? null;
    return NightlyPublicationState.parse({
      reportId,
      parent,
      children: items.filter((item) => item.kind !== "nightly_run"),
    });
  }
}

function toPublication(row: PublicationRow): WorkItemPublication {
  const hasIssue = row.external_id !== null && row.external_number !== null && row.external_url !== null;
  return WorkItemPublication.parse({
    workItemId: row.work_item_id,
    kind: row.kind,
    title: row.title,
    // A work item with no publication row has never been attempted; the marker is
    // derived (it is a pure function of the id) so the record is still complete.
    marker: row.marker || workItemIssueMarker(row.work_item_id),
    issue: hasIssue
      ? { provider: "github", number: row.external_number, externalId: row.external_id, url: row.external_url }
      : null,
    attachedToParent: row.attached_to_parent,
    publicationError: row.publication_error,
    attachmentError: row.attachment_error,
  });
}
