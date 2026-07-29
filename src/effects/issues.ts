import { z } from "zod";
import { SubjectRevision } from "../domain/evidence/types.js";
import { NightlyWorkItemKind } from "../domain/findings/work-graph.js";
import {
  renderPublicationStatus,
  type IssueExternalRef,
  type NightlyPublicationState,
} from "../domain/findings/work-publication.js";
import type { IssueUpsertInput } from "../providers/scm/port.js";

/**
 * Outbox payloads for nightly work-item issue publication.
 *
 * Persisted JSON is untrusted at the boundary (heritage scar), so the dispatcher
 * parses every payload through these schemas before performing a GitHub write. The
 * payloads carry only what is FIXED at commit time — repository, marker, planned
 * title/body. Anything that depends on how publication actually went (the parent's
 * issue number, which children failed) is read from the durable publication state at
 * dispatch time, because it is not knowable when the effect is enqueued.
 */

/** Effect type names. Exported so planners, the dispatcher, and tests share one spelling. */
export const NIGHTLY_ISSUE_EFFECT = "nightly_issue";
export const NIGHTLY_ISSUE_LINK_EFFECT = "nightly_issue_link";
export const NIGHTLY_ISSUE_SUMMARY_EFFECT = "nightly_issue_summary";
export const NIGHTLY_CHECK_REFRESH_EFFECT = "nightly_check_refresh";

/** Publish (create or update) one work item as an issue. */
export const NightlyIssuePayload = z.object({
  workItemId: z.string().min(1),
  reportId: z.string().min(1),
  kind: NightlyWorkItemKind,
  repository: SubjectRevision.shape.repository,
  /** Stable hidden marker — the adapter's only identity key. */
  marker: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  /**
   * The parent work item, for children. The dispatcher resolves its issue number at
   * delivery time and links it into the child body — the number cannot be known when
   * this payload is written, which is exactly why the dependency is explicit.
   */
  parentWorkItemId: z.string().min(1).nullable(),
});
export type NightlyIssuePayload = z.infer<typeof NightlyIssuePayload>;

/** Attach one child work item's issue under its parent's. */
export const NightlyIssueLinkPayload = z.object({
  repository: SubjectRevision.shape.repository,
  parentWorkItemId: z.string().min(1),
  childWorkItemId: z.string().min(1),
});
export type NightlyIssueLinkPayload = z.infer<typeof NightlyIssueLinkPayload>;

/**
 * Reconcile the parent issue body once every child's publication has settled, so
 * the parent names the children that could not be filed or attached.
 */
export const NightlyIssueSummaryPayload = z.object({
  reportId: z.string().min(1),
  parentWorkItemId: z.string().min(1),
  repository: SubjectRevision.shape.repository,
  marker: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  title: z.string().min(1),
  /** The planned parent body; the publication status section is appended at dispatch. */
  body: z.string().min(1),
});
export type NightlyIssueSummaryPayload = z.infer<typeof NightlyIssueSummaryPayload>;

/**
 * Re-post the nightly check once publication has settled, linking the parent issue
 * when there is one.
 *
 * The base title/summary are the ones the report already rendered (same projection,
 * so the check cannot drift from the persisted report), and the publication section
 * is appended from durable state. This effect deliberately does NOT depend on the
 * parent issue existing: when publication failed, an honest check is exactly what is
 * needed, and a dependency on the reference would suppress it.
 */
export const NightlyCheckRefreshPayload = z.object({
  reportId: z.string().min(1),
  parentWorkItemId: z.string().min(1),
  subject: SubjectRevision,
  /** The check-run idempotency key — the SAME one the initial check used. */
  externalId: z.string().min(1),
  name: z.string().min(1),
  conclusion: z.enum(["success", "failure", "neutral"]),
  title: z.string().min(1),
  summary: z.string(),
});
export type NightlyCheckRefreshPayload = z.infer<typeof NightlyCheckRefreshPayload>;

/**
 * `knownRef` is the reference ALREADY persisted for this work item, when there is
 * one. Passing it lets the adapter update that issue directly instead of walking the
 * repository's issue history to rediscover what we already know — which is every
 * re-dispatch and every body reconciliation. Omitting it (no local reference: the
 * crash-between-create-and-persist case) is what puts the marker lookup back in
 * play, so identity is unchanged.
 */
export function toIssueUpsertInput(
  payload: Pick<NightlyIssuePayload, "repository" | "marker" | "labels" | "title" | "body">,
  body = payload.body,
  knownRef?: IssueExternalRef | null,
): IssueUpsertInput {
  return {
    repository: payload.repository,
    marker: payload.marker,
    labels: payload.labels,
    title: payload.title,
    body,
    ...(knownRef ? { knownRef: { number: knownRef.number, id: knownRef.externalId, url: knownRef.url } } : {}),
  };
}

/**
 * A child issue body plus its parent back-link. Provider-neutral in the domain
 * (the graph knows only work-item ids); the human-facing link needs the number,
 * which only exists once the parent is published — hence rendered here.
 */
export function withParentLink(body: string, parent: IssueExternalRef | null): string {
  if (parent === null) return body;
  return `${body}\n\nParent: ${parent.url}`;
}

/** Section appended to the parent issue body / check summary from durable state. */
export function publicationSection(state: NightlyPublicationState): string {
  return ["## Publication status", "", renderPublicationStatus(state)].join("\n");
}

/**
 * The check summary, extended with the parent link and the honest publication
 * status. Never claims publication succeeded: the link line reports the failure or
 * the pending delivery when there is no issue to point at.
 */
export function checkSummaryWithPublication(baseSummary: string, state: NightlyPublicationState | null): string {
  if (state === null || state.parent === null) return baseSummary;
  const parent = state.parent;
  const link =
    parent.issue !== null
      ? `Tracked as ${parent.issue.url}`
      : parent.publicationError !== null
        ? `The tracking issue for this run **could not be created**: ${parent.publicationError}`
        : "The tracking issue for this run has not been created yet (delivery pending).";
  return [baseSummary, "", link, "", renderPublicationStatus(state)].join("\n");
}
