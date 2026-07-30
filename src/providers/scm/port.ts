import type { SubjectRevision } from "../../domain/evidence/types.js";
import type { CiEvidence, PullRequestObservation } from "../../domain/fixes/lifecycle.js";

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

/** A path's full content, read completely at an immutable subject revision. */
export interface FileContentComplete {
  complete: true;
  path: string;
  content: string;
}

/**
 * A path that could not be read completely. Never fabricated as empty content:
 * a caller anchoring a patch edit against `""` when the read actually failed
 * would treat "could not read" as "empty file", which can only ever produce a
 * wrong or unsafe edit.
 */
export interface FileContentError {
  complete: false;
  path: string;
  reason: "not_found" | "binary" | "oversized" | "provider_error";
  detail?: string;
}

export type FileContentResult = FileContentComplete | FileContentError;

export interface ScmReader {
  /** Changed files for a PR/subject, by immutable revision. */
  getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]>;
  /** Changed files across a range (base, head]. Used by the nightly gate. */
  getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]>;
  /**
   * Full, immutable content of one path at `subject`. This is the anchor
   * material remediation uses to bind a proposed edit's preimage to real
   * source — never a diff/patch, and never a partial read reported as
   * complete. A read that cannot be served in full (missing, binary,
   * oversized, or a provider fault) reports `complete: false` with a stable
   * reason rather than throwing, so a caller can attribute the gap to one
   * finding's remediation attempt instead of aborting the whole run.
   */
  getFileContent(subject: SubjectRevision, path: string): Promise<FileContentResult>;
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

/**
 * A single line-scoped edit applied by a fix PR.
 *
 * `expectedOriginal` is the PRECONDITION: the exact text those lines must
 * contain in the reviewed subject. An adapter that receives it MUST verify it
 * against content read at the reviewed sha and refuse the whole proposal on a
 * mismatch, rather than replacing whatever happens to be there. It is optional
 * because deterministic fixers are pure functions of a finding's region and read
 * no content, so they have no original text to honestly claim; those edits are
 * still bound to the candidate because the adapter anchors the commit to the
 * reviewed sha itself.
 */
export interface PullRequestEdit {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
  expectedOriginal?: string;
}

/** Which fixer/model/prompt produced the patch, carried through to the PR. */
export interface PullRequestProvenance {
  fixerKind: "deterministic" | "model";
  fixerId: string;
  fixerVersion: string;
  modelId: string | null;
  promptVersion: string | null;
  proposalSchemaVersion: string;
}

export interface PullRequestInput {
  /** The reviewed head the fix is proposed against (immutable candidate). */
  subject: SubjectRevision;
  /** Stable idempotency key; re-opening with the same key must not duplicate. */
  externalId: string;
  /** Candidate-bound head branch for the fix (see `fixProposalBranch`). */
  branch: string;
  /**
   * The branch the review ran on — the PR's merge target. Optional for
   * backward compatibility with persisted effects; an adapter falls back to the
   * repository's default branch when absent.
   */
  baseBranch?: string;
  /**
   * The reviewed range's base sha (null on a branch's first review). Part of the
   * reviewed identity, NOT the merge target — recorded so a human can see which
   * range produced the proposal.
   */
  baseSha?: string | null;
  title: string;
  body: string;
  edits: PullRequestEdit[];
  /**
   * Open as a draft. A structurally safe but semantically unconfirmed patch is a
   * draft; a critic-confirmed one is ready for review. Part of the provider
   * contract because "clearly marked draft" is a safety property, not styling.
   */
  draft: boolean;
  /**
   * Fix proposal identity. The adapter writes it into the commit message as the
   * manifest that proves THIS proposal landed on the branch.
   */
  proposalId: string;
  /** The published child finding issue this PR remediates, when already known. */
  childIssue?: IssueRef;
  provenance?: PullRequestProvenance;
}

export interface PullRequestResult {
  /** Provider PR number/handle. */
  number: number;
  /** Provider URL, stored so a human never has to reconstruct it. */
  url: string;
  /**
   * The PR's head sha at the moment of this call. IMMUTABLE evidence anchor: all
   * CI evidence is bound to a head sha, so a stored verdict can never be carried
   * onto a later head.
   */
  headSha: string;
  /** Draft state as the provider reports it (not as we requested it). */
  draft: boolean;
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
 * WHERE it looks to issues carrying these labels. An adapter that scopes its
 * lookup by label MUST re-apply the labels on update, or a human who removed one
 * would turn a label into part of the identity and the next publication would
 * open a duplicate.
 */
export interface IssueUpsertInput {
  repository: string;
  /** Stable hidden Scruffy marker. See `workItemIssueMarker`. */
  marker: string;
  /** Labels applied on create AND re-applied on update; also scope the lookup. */
  labels: readonly string[];
  title: string;
  body: string;
  /**
   * A reference the CALLER already holds from a previous successful publication.
   *
   * An optimisation, never an identity: when it is present the adapter may update
   * that issue directly and skip the marker lookup entirely, which is the
   * difference between one request and a walk of the repository's whole
   * label-scoped issue history on every re-dispatch. When it is absent — the
   * crash-between-create-and-persist case — the marker lookup is the only thing
   * standing between a retry and a duplicate, so it still runs.
   */
  knownRef?: IssueRef;
  /**
   * Desired issue state. Absent means "leave whatever state it is in" — the
   * default, because Scruffy must not reopen an issue a human deliberately closed
   * every time it refreshes a body.
   *
   * `closed` is only ever requested for work Scruffy has durably decided is
   * terminal (a verified/dismissed child, or a parent whose children are all
   * terminal and whose coverage is complete). An adapter MUST NOT close on create.
   */
  state?: "open" | "closed";
  /** Provider close reason where supported. Ignored unless `state` is `closed`. */
  stateReason?: "completed" | "not_planned";
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

/** A tracker issue's current state, as the provider reports it. */
export interface ExternalIssueObservation {
  number: number;
  state: "open" | "closed";
  /** Provider close reason (`completed`/`not_planned`), or null when withheld. */
  stateReason: string | null;
  /** Login of whoever closed it, or null when the provider does not say. */
  closedBy: string | null;
}

/**
 * READ half of the fix lifecycle — the states humans and repository CI produce
 * that Scruffy consumes as evidence.
 *
 * Separate from `ScmReader` (analysis-time source reads) and from `ScmWriter`
 * (the narrow effects credential) because it needs neither: reconciliation reads
 * provider state and writes nothing. Everything is keyed by an IMMUTABLE handle —
 * a PR number, a sha, a branch, an issue number — so a reconciler can never
 * conflate two candidates.
 */
export interface ScmLifecycleReader {
  /** Current PR state, or null when the provider no longer has it. */
  getPullRequest(repository: string, number: number): Promise<PullRequestObservation | null>;
  /**
   * All CI evidence for exactly `sha` — check runs AND combined commit statuses,
   * because repositories use either or both. The returned evidence carries the
   * sha it was read at so a caller cannot accidentally apply it to another head.
   */
  getCiEvidence(repository: string, sha: string): Promise<CiEvidence>;
  /** Immutable head sha of a branch (the post-merge candidate), or null. */
  getBranchHead(repository: string, branch: string): Promise<string | null>;
  /** Current issue state, so a human closure can be recorded as a dismissal. */
  getIssueState(repository: string, number: number): Promise<ExternalIssueObservation | null>;
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
  /**
   * Idempotent fix-PR open keyed by externalId. Never auto-merges.
   *
   * The adapter MUST: verify every supplied `expectedOriginal` against content
   * read at `subject.commitSha`; land all edits together (one commit, or an
   * equivalently crash-safe manifest) before opening the PR; and refuse — loudly,
   * without opening a misleading PR — when the head branch already exists but
   * does not carry THIS proposal's manifest.
   */
  openPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
}
