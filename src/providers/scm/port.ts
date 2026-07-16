import type { SubjectRevision } from "../../domain/evidence/types.js";

/**
 * SCM adapter port. GitHub-specific mechanics live behind this; the domain and
 * gates never import Octokit (ADR 0003 provider-neutrality). Azure DevOps will
 * be a second implementation later.
 *
 * Split into read and write halves because they sit on different trust/credential
 * boundaries: analysis workers read; only the effects component writes.
 */

export interface ChangedFile {
  path: string;
  /** Unified-diff patch for the file, as the SCM returns it. */
  patch: string;
}

/**
 * An immutable revision range for nightly review: everything reached by `headSha`
 * but not by `baseSha`. `baseSha` is null for a branch's first-ever review, in
 * which case the adapter returns the head candidate's own change set.
 */
export interface RevisionRange {
  repository: string;
  baseSha: string | null;
  headSha: string;
}

export interface ScmReader {
  /** Changed files for a PR/subject, by immutable revision. */
  getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]>;
  /** Changed files across a range (base, head]. Used by the nightly gate. */
  getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]>;
}

export type CheckConclusion = "success" | "failure" | "neutral";

export interface CheckRunInput {
  subject: SubjectRevision;
  /** Stable external key; re-posting with the same key must be idempotent. */
  externalId: string;
  name: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
}

export interface CheckRunResult {
  id: string;
  /** True when this call created a new check run; false when it matched an existing one. */
  created: boolean;
}

/** A single line-scoped edit applied by a fix PR. */
export interface PullRequestEdit {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface PullRequestInput {
  /** The reviewed head the fix is proposed against. */
  subject: SubjectRevision;
  /** Stable idempotency key; re-opening with the same key must not duplicate. */
  externalId: string;
  /** Deterministic head branch for the fix. */
  branch: string;
  title: string;
  body: string;
  edits: PullRequestEdit[];
}

export interface PullRequestResult {
  /** Provider PR number/handle. */
  number: number;
  /** True when this call opened a new PR; false when it matched an existing one. */
  created: boolean;
}

export interface ScmWriter {
  /** Idempotent upsert keyed by (subject, externalId). */
  upsertCheckRun(input: CheckRunInput): Promise<CheckRunResult>;
  /** Idempotent fix-PR open keyed by externalId. Never auto-merges. */
  openPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
}
