import { z } from "zod";
import type { SubjectRevision } from "../evidence/types.js";

/**
 * Factual, context-only work associated with a repository at report time.
 *
 * This snapshot is deliberately outside the release evidence manifest: ordinary
 * backlog issues and unrelated open pull requests do not gain release authority
 * merely by being visible. The release decision kernel never consumes this shape.
 */

const WorkLink = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
});

export const OpenBugIssue = WorkLink.extend({
  title: z.string(),
  labels: z.array(z.string()),
  updatedAt: z.string().optional(),
});
export type OpenBugIssue = z.infer<typeof OpenBugIssue>;

export const OpenPullRequestContext = WorkLink.extend({
  title: z.string(),
  draft: z.boolean(),
  headSha: z.string().min(1),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  author: z.string().optional(),
  updatedAt: z.string().optional(),
  /** True only when the provider-reported PR head equals the report candidate. */
  candidate: z.boolean(),
});
export type OpenPullRequestContext = z.infer<typeof OpenPullRequestContext>;

export const TrackedNightlyFinding = z.object({
  findingKey: z.string().min(1),
  defectClass: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  resolution: z.enum(["open", "awaiting_verification"]),
  issue: WorkLink.nullable(),
  proposal: z
    .object({
      delivery: z.string().min(1),
      ci: z.string().min(1),
      merge: z.string().min(1),
      pullRequest: WorkLink.nullable(),
      deliveryError: z.string().nullable(),
    })
    .nullable(),
});
export type TrackedNightlyFinding = z.infer<typeof TrackedNightlyFinding>;

const ContextStatus = z.enum(["complete", "partial", "failed"]);

export const ReleaseOutstandingWork = z.object({
  /** Load-bearing marker: none of this snapshot changes the release outcome. */
  contextOnly: z.literal(true),
  repository: z.object({
    status: ContextStatus,
    bugLabel: z.literal("bug"),
    bugIssues: z.array(OpenBugIssue),
    openPullRequests: z.array(OpenPullRequestContext),
    gaps: z.array(z.string()),
  }),
  nightly: z.object({
    status: ContextStatus,
    reportsConsidered: z.number().int().nonnegative(),
    requiredCoverageComplete: z.boolean(),
    parentIssues: z.array(WorkLink),
    findings: z.array(TrackedNightlyFinding),
    gaps: z.array(z.string()),
  }),
});
export type ReleaseOutstandingWork = z.infer<typeof ReleaseOutstandingWork>;

/** Read-only application boundary. Implementations may observe; they cannot mutate. */
export interface ReleaseOutstandingWorkReader {
  read(subject: SubjectRevision): Promise<ReleaseOutstandingWork>;
}

/** Honest fallback when context collection was not configured or unexpectedly failed. */
export function unavailableOutstandingWork(reason: string): ReleaseOutstandingWork {
  return {
    contextOnly: true,
    repository: {
      status: "failed",
      bugLabel: "bug",
      bugIssues: [],
      openPullRequests: [],
      gaps: [reason],
    },
    nightly: {
      status: "failed",
      reportsConsidered: 0,
      requiredCoverageComplete: false,
      parentIssues: [],
      findings: [],
      gaps: [reason],
    },
  };
}
