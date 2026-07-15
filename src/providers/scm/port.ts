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

export interface ScmReader {
  /** Changed files for a PR/subject, by immutable revision. */
  getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]>;
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

export interface ScmWriter {
  /** Idempotent upsert keyed by (subject, externalId). */
  upsertCheckRun(input: CheckRunInput): Promise<CheckRunResult>;
}
