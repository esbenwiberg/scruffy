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

/**
 * A provider-neutral reference to a published tracker issue.
 *
 * Two identifiers, because GitHub needs both and they are not interchangeable:
 * `number` is the human/URL handle used on every `/issues/{number}` route, while
 * `id` is the provider's stable record identifier — the value the native
 * sub-issue endpoint accepts. Azure DevOps work items collapse the two; the
 * domain keeps them separate so an adapter never has to guess.
 */
export interface IssueRef {
  /** Provider handle used in issue routes and URLs (GitHub issue number). */
  number: number;
  /** Provider-side stable record id (GitHub issue database id). */
  id: string;
  url: string;
}

/**
 * Create-or-update one tracker issue.
 *
 * IDENTITY IS THE MARKER, NOT THE TITLE. GitHub issues have no `external_id`
 * field, so the only way an adapter can recognise an issue it already created is
 * a value it embedded in the issue itself. `marker` is that value: the adapter
 * MUST embed it in the published body and MUST use it — never the title, never a
 * search query whose index lags behind the write — to decide create vs update.
 * That is what makes a crash between "GitHub created the issue" and "we stored
 * the result" recoverable instead of duplicating.
 *
 * `labels` narrows the lookup server-side. It is an efficiency contract, not an
 * identity one: an adapter may only match on the marker, but it may restrict
 * WHERE it looks to issues carrying these labels.
 */
export interface IssueUpsertInput {
  repository: string;
  /** Stable hidden Scruffy marker. See `workItemIssueMarker`. */
  marker: string;
  /** Labels applied on create and used to scope the marker lookup. */
  labels: readonly string[];
  title: string;
  body: string;
}

export interface IssueUpsertResult extends IssueRef {
  /** True when this call created the issue, false when it matched the marker. */
  created: boolean;
}

/** Attach `child` under `parent` in the provider's native hierarchy. */
export interface IssueLinkInput {
  repository: string;
  parent: IssueRef;
  child: IssueRef;
}

export interface IssueLinkResult {
  /** True when the link already existed — re-linking must never duplicate. */
  alreadyLinked: boolean;
}

/**
 * Issue publication half of the writer. Split out so a caller that only
 * publishes work items can be typed against exactly that, and so a second
 * provider (Azure DevOps work items) has one obvious surface to implement.
 *
 * Both operations are idempotent: repeating them with the same input converges
 * on one issue and one link.
 */
export interface ScmIssueWriter {
  /**
   * Idempotent on (repository, marker). Re-invoking with the same marker updates
   * the matched issue rather than opening a second one.
   */
  upsertIssue(input: IssueUpsertInput): Promise<IssueUpsertResult>;
  /**
   * Idempotent parent/child attachment. Attaching an already-attached child is a
   * no-op reported as `alreadyLinked: true`.
   */
  linkChildIssue(input: IssueLinkInput): Promise<IssueLinkResult>;
}

export interface ScmWriter extends ScmIssueWriter {
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
