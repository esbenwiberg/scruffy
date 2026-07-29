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

/**
 * Normalized terminal state of ONE candidate-CI signal. Provider-specific
 * vocabularies (GitHub check-run conclusions AND commit-status states) collapse
 * into this single set. Only `success` is a clean, unambiguous pass — every other
 * value (including `pending`, which is not terminal, and `unknown`, which is a
 * malformed/unrecognized signal) is NOT clean and holds a release.
 */
export type CandidateCiState =
  | "success"
  | "failure"
  | "pending"
  | "cancelled"
  | "timed-out"
  | "neutral"
  | "action-required"
  | "error"
  | "unknown";

/** One normalized CI record, bound to the exact commit SHA it was gathered for. */
export interface CandidateCiRecord {
  /** The check-run name or commit-status context. */
  context: string;
  state: CandidateCiState;
  /** The exact commit SHA this record belongs to (a check-run's head_sha, or the
   * requested candidate for a per-sha commit-status read). Bound to the candidate,
   * NEVER to a branch name — duplicate/wrong-SHA evidence is resolved downstream. */
  sha: string;
  source: "check-run" | "commit-status";
  /** Provider ordering hint (ISO timestamp) for resolving duplicate records of one
   * context to a clear latest. Absent when the provider supplied none. */
  updatedAt?: string;
}

/**
 * All normalized CI records for an EXACT candidate SHA. An empty `records` list is
 * a genuinely CI-less candidate — NEVER a stand-in for a read that failed. Adapters
 * MUST throw on any API/schema failure rather than return an empty successful set.
 */
export interface CandidateCiEvidence {
  /** The exact candidate SHA the evidence was gathered for. */
  sha: string;
  records: CandidateCiRecord[];
}

export interface ScmReader {
  /** Changed files for a PR/subject, by immutable revision. */
  getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]>;
  /** Changed files across a range (base, head]. Used by the nightly gate. */
  getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]>;
  /**
   * Normalized candidate-CI evidence (GitHub check runs + commit statuses) for the
   * EXACT candidate SHA in `subject`. Reads and records bind to the candidate SHA,
   * never a branch. MUST throw on any API/schema failure — an empty successful list
   * is reserved for a candidate that genuinely has no CI signal, and a fault that
   * masqueraded as "no required checks" would false-green the release lane.
   */
  getCandidateCi(subject: SubjectRevision): Promise<CandidateCiEvidence>;
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
  /**
   * ADVISORY (best-effort): true when this call created a new check run, false
   * when it matched an existing one. A backend with a prior-existence signal
   * (e.g. FakeScm, or a real check-run object) reports this exactly; a backend
   * without one (e.g. the gh-cli adapter, which posts commit statuses that have
   * no create-vs-supersede signal) may always report true. Effects logic MUST
   * NOT gate correctness on `created` — the safety invariant is that repeating
   * the upsert never produces a duplicate effect (see upsertCheckRun), not that
   * `created` reliably detects a redelivery.
   */
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
  /**
   * The branch the review ran on — the PR's merge target. Optional for
   * backward compatibility with persisted effects; an adapter falls back to the
   * repository's default branch when absent.
   */
  baseBranch?: string;
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
  /**
   * Idempotent upsert. The canonical key is (subject, externalId); the invariant
   * callers may rely on is that re-invoking with the same input never produces a
   * duplicate effect. Note the key an adapter can actually enforce may be coarser
   * than externalId: the gh-cli adapter keys on (subject, name) because a commit
   * status is "latest per (sha, context) wins", so two inputs sharing a name
   * supersede each other even with different externalIds. `created` is advisory
   * (see CheckRunResult) — do not build created-gated side effects on top of it.
   */
  upsertCheckRun(input: CheckRunInput): Promise<CheckRunResult>;
  /** Idempotent fix-PR open keyed by externalId. Never auto-merges. */
  openPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
}
