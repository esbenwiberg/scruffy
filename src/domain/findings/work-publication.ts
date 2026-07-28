import { z } from "zod";
import { NightlyWorkItemKind } from "./work-graph.js";

/**
 * Publication state for the nightly work graph: the durable record of WHERE each
 * provider-neutral work item ended up, and whether it got there at all.
 *
 * WHY THIS IS SEPARATE FROM THE GRAPH. `NightlyWorkGraph` is publication INTENT —
 * a pure function of the report, replannable at any time. This module is
 * publication FACT: issue numbers, hierarchy attachment, and the failures that
 * stopped either from happening. Keeping them apart is what lets a re-commit of
 * the same report rewrite the intent (titles, bodies) without ever rewriting the
 * external references a previous publication already earned, and what lets the
 * check say "3 findings, 1 of them could not be filed" instead of quietly
 * implying every work item reached a human.
 *
 * Pure: no IO, no clock. The marker helpers are the only identity here, and they
 * are derived from the work-item id alone so a crash-resume lookup can be
 * reconstructed from nothing but the durable graph.
 */

/**
 * Version of the hidden marker FORMAT. It is part of the marker text, so a future
 * format change is a different marker rather than a silent redefinition — and a
 * lookup for the old format keeps working against already-published issues.
 */
export const SCRUFFY_ISSUE_MARKER_VERSION = "scruffy-work-item-1";

/**
 * Label applied to every Scruffy-published issue. NOT an identity: it exists so
 * the marker lookup can be scoped server-side to Scruffy's own issues instead of
 * walking a repository's entire issue history. Matching is always on the marker.
 */
export const SCRUFFY_ISSUE_LABEL = "scruffy";

/**
 * Additional labels per work-item kind, so a human can filter the parent run
 * issue from its children without reading bodies.
 */
export function issueLabelsFor(kind: NightlyWorkItemKind): string[] {
  switch (kind) {
    case "nightly_run":
      return [SCRUFFY_ISSUE_LABEL, "scruffy:nightly-run"];
    case "finding":
      return [SCRUFFY_ISSUE_LABEL, "scruffy:finding"];
    case "coverage_gap":
      return [SCRUFFY_ISSUE_LABEL, "scruffy:coverage-gap"];
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * The hidden marker embedded in a published issue body.
 *
 * An HTML comment so it renders as nothing on GitHub, and derived purely from the
 * work-item id — which is itself derived from the immutable report/occurrence
 * identity. Two consequences the whole idempotency story rests on: the same work
 * item always produces the same marker (so a crashed publication is recoverable),
 * and the same rule at the same line on a LATER candidate produces a DIFFERENT
 * marker (so today's finding can never match yesterday's closed issue).
 */
export function workItemIssueMarker(workItemId: string): string {
  return `<!-- ${SCRUFFY_ISSUE_MARKER_VERSION}:${workItemId} -->`;
}

/** The work-item id inside a published body's marker, or null when absent. */
export function parseWorkItemIssueMarker(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = new RegExp(`<!--\\s*${SCRUFFY_ISSUE_MARKER_VERSION}:([^\\s>]+?)\\s*-->`).exec(body);
  return match ? match[1]! : null;
}

/** Append the marker unless the body already carries it (an update re-round-trip). */
export function withIssueMarker(body: string, marker: string): string {
  return body.includes(marker) ? body : `${body}\n\n${marker}`;
}

/**
 * A published issue as stored against a work item. `provider` is recorded so a
 * second SCM provider cannot have its handles silently read as GitHub's.
 */
export const IssueExternalRef = z.object({
  provider: z.literal("github"),
  number: z.number().int().positive(),
  /** Provider-side stable record id (GitHub issue database id), as text. */
  externalId: z.string().min(1),
  url: z.string().min(1),
});
export type IssueExternalRef = z.infer<typeof IssueExternalRef>;

/**
 * What happened when Scruffy tried to publish one work item.
 *
 * `issue === null && publicationError === null` means "not attempted yet", which
 * is deliberately distinguishable from "attempted and failed": the first is a
 * pending effect, the second is a durable, human-visible gap in the work graph.
 */
export const WorkItemPublication = z
  .object({
    workItemId: z.string().min(1),
    kind: NightlyWorkItemKind,
    title: z.string().min(1),
    marker: z.string().min(1),
    issue: IssueExternalRef.nullable(),
    /** True once the child is attached under its parent in the provider hierarchy. */
    attachedToParent: z.boolean(),
    /** Why issue creation/update failed terminally, or null. */
    publicationError: z.string().nullable(),
    /** Why hierarchy attachment failed terminally, or null. */
    attachmentError: z.string().nullable(),
  })
  .superRefine((record, ctx) => {
    // A recorded external reference and a recorded terminal publication failure are
    // contradictory claims about the same attempt; storing both would let a report
    // render "published" and "failed" for one item depending on which field a reader
    // happened to check.
    if (record.issue !== null && record.publicationError !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publicationError"],
        message: "a published work item cannot also carry a terminal publication failure",
      });
    }
    if (record.attachedToParent && record.attachmentError !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachmentError"],
        message: "an attached child cannot also carry a terminal attachment failure",
      });
    }
    if (record.kind === "nightly_run" && record.attachedToParent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attachedToParent"], message: "the parent has no parent to attach to" });
    }
  });
export type WorkItemPublication = z.infer<typeof WorkItemPublication>;

/** Publication state for one report's whole work graph. */
export const NightlyPublicationState = z
  .object({
    reportId: z.string().min(1),
    /** Null when the report planned no work at all (a complete, clean run). */
    parent: WorkItemPublication.nullable(),
    children: z.array(WorkItemPublication),
  })
  .superRefine((state, ctx) => {
    if (state.parent === null && state.children.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["children"], message: "children require a parent work item" });
    }
    if (state.parent !== null && state.parent.kind !== "nightly_run") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parent"], message: "the parent must be the 'nightly_run' work item" });
    }
  });
export type NightlyPublicationState = z.infer<typeof NightlyPublicationState>;

/**
 * What an effect makes available to dependent effects. The outbox stores this so
 * a dependency is a declared fact about the effect, not an inference from row
 * order — insertion order is not a correctness mechanism, and a retry, a lease
 * expiry, or a partly-failed batch reorders delivery freely.
 */
export const EffectProductionKind = z.enum(["issue_reference", "attachment"]);
export type EffectProductionKind = z.infer<typeof EffectProductionKind>;

export const EffectProduction = z.object({
  workItemId: z.string().min(1),
  kind: EffectProductionKind,
});
export type EffectProduction = z.infer<typeof EffectProduction>;

/**
 * What an effect needs before it can be delivered.
 *
 *  - `issue_reference`  — the work item's issue must EXIST. A terminal publication
 *    failure makes this permanently unsatisfiable, so dependents are cascaded to
 *    a terminal failure of their own rather than waiting forever.
 *  - `publication_settled` — the work item's publication has reached a terminal
 *    outcome, success OR failure. This is what a reconciliation effect waits on:
 *    it must still run (and report the failure) when publication did not work.
 *  - `attachment_settled` — likewise for hierarchy attachment. A child that was
 *    never published counts as settled: there is nothing left to attach.
 */
export const EffectDependencyKind = z.enum(["issue_reference", "publication_settled", "attachment_settled"]);
export type EffectDependencyKind = z.infer<typeof EffectDependencyKind>;

export const EffectDependency = z.object({
  workItemId: z.string().min(1),
  requires: EffectDependencyKind,
});
export type EffectDependency = z.infer<typeof EffectDependency>;

/** Counts for a one-line publication summary. */
export interface PublicationCounts {
  planned: number;
  published: number;
  attached: number;
  failed: number;
}

export function countPublications(state: NightlyPublicationState): PublicationCounts {
  const all = state.parent === null ? [] : [state.parent, ...state.children];
  return {
    planned: all.length,
    published: all.filter((item) => item.issue !== null).length,
    // Only children can be attached; the parent is the root of the hierarchy.
    attached: state.children.filter((item) => item.attachedToParent).length,
    failed: all.filter((item) => item.publicationError !== null || item.attachmentError !== null).length,
  };
}

/**
 * Render the publication status section for the parent issue body and the nightly
 * check summary.
 *
 * The one thing this must never do is imply success it does not have. Every child
 * that failed to publish or attach is named with its reason, and a child that has
 * not been attempted yet is reported as pending rather than folded into either
 * bucket — a reader must be able to tell "not filed yet" from "could not be filed".
 */
export function renderPublicationStatus(state: NightlyPublicationState): string {
  if (state.parent === null) return "No work items were planned for this report.";

  const counts = countPublications(state);
  const lines: string[] = [
    `Work items: ${counts.planned} planned, ${counts.published} filed as issues, ` +
      `${counts.attached}/${state.children.length} children attached to this parent.`,
  ];

  const problems: string[] = [];
  for (const item of [state.parent, ...state.children]) {
    if (item.publicationError !== null) {
      problems.push(`- \`${item.workItemId}\` (${item.kind}) **could not be filed**: ${item.publicationError}`);
    } else if (item.issue === null) {
      problems.push(`- \`${item.workItemId}\` (${item.kind}) is **not filed yet** (delivery still pending).`);
    } else if (item.kind !== "nightly_run" && !item.attachedToParent) {
      problems.push(
        item.attachmentError !== null
          ? `- #${item.issue.number} **could not be attached** to this parent: ${item.attachmentError}`
          : `- #${item.issue.number} is filed but **not attached yet** (delivery still pending).`,
      );
    }
  }

  if (problems.length === 0) {
    lines.push("", "Every planned work item was filed and attached.");
  } else {
    lines.push(
      "",
      "**This work graph is not fully published.** Scruffy reports the gap rather than implying every item reached a human:",
      ...problems,
    );
  }
  return lines.join("\n");
}
