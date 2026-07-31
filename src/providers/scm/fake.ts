import { createHash } from "node:crypto";
import type { SubjectRevision } from "../../domain/evidence/types.js";
import type {
  CandidateCiEvidence,
  ChangedFile,
  CheckRunInput,
  CheckRunResult,
  ExternalIssueObservation,
  FileContentResult,
  IssueLinkInput,
  IssueLinkResult,
  InstalledRepository,
  IssueUpsertInput,
  IssueUpsertResult,
  PullRequestInput,
  PullRequestResult,
  RepositoryOpenWorkObservation,
  RevisionRange,
  ScmInstallationReader,
  ScmLifecycleReader,
  ScmReader,
  ScmWriter,
} from "./port.js";
import { withIssueMarker } from "../../domain/findings/work-publication.js";
import { commitCarriesProposal, fixCommitMessage } from "../../domain/fixes/delivery.js";
import type { CiEvidence, PullRequestObservation } from "../../domain/fixes/lifecycle.js";

/** One published issue as the fake holds it; `input.body` carries the marker. */
export interface FakeIssue {
  repository: string;
  ref: IssueUpsertResult;
  input: IssueUpsertInput;
  /** Provider-side state. Only a caller that ASKED for a state ever changes it. */
  state: "open" | "closed";
}

/**
 * Deterministic in-memory SCM double for tests and the harness.
 *
 * The reader replays seeded changed-file fixtures. The writer records check-run
 * upserts and enforces idempotency on (subject, externalId) so the harness can
 * assert that duplicate delivery does not produce duplicate effects — the real
 * risk the effects component must defend against.
 *
 * Fixtures use the SAME shapes GitHub returns; when we add the real adapter, a
 * contract test recorded from Octokit keeps these honest.
 */
/** One fix PR as the fake holds it, including the state humans/CI move it through. */
export interface FakePullRequest {
  number: number;
  url: string;
  headSha: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
  repository: string;
  branch: string;
  input: PullRequestInput;
}

export class FakeScm implements ScmReader, ScmWriter, ScmLifecycleReader, ScmInstallationReader {
  readonly #files = new Map<string, ChangedFile[]>();
  readonly #rangeFiles = new Map<string, ChangedFile[]>();
  readonly #fileContent = new Map<string, FileContentResult>();
  readonly #candidateCi = new Map<string, CandidateCiEvidence>();
  readonly #checkRuns = new Map<string, { id: string; input: CheckRunInput }>();
  readonly #pullRequests = new Map<string, FakePullRequest>();
  /** `repository#branch` -> the branch's head commit, mirroring a git ref. */
  readonly #branches = new Map<string, { sha: string; message: string }>();
  /** `repository@sha` -> CI evidence the repository posted for that commit. */
  readonly #ci = new Map<string, CiEvidence>();
  readonly #issues: FakeIssue[] = [];
  /** `repository#parentNumber` -> child database id -> child number. */
  readonly #subIssues = new Map<string, Map<number, number>>();
  readonly #issueState = new Map<number, ExternalIssueObservation>();
  /** Repositories the "installation" can see, in seeded order. */
  #installed: InstalledRepository[] | null = null;
  /** When set, the next listing throws it — a provider fault, never an empty list. */
  #installationFault: Error | null = null;
  #installationListings = 0;
  #idSeq = 0;
  #prSeq = 0;
  #issueSeq = 0;

  seedChangedFiles(subject: SubjectRevision, files: ChangedFile[]): void {
    this.#files.set(this.#subjectKey(subject), files);
  }

  seedChangedFilesInRange(range: RevisionRange, files: ChangedFile[]): void {
    this.#rangeFiles.set(this.#rangeKey(range), files);
  }

  /** Seed full immutable content for `path` at `subject`. Plain string convenience overload seeds a complete read. */
  seedFileContent(subject: SubjectRevision, path: string, content: string): void;
  seedFileContent(subject: SubjectRevision, path: string, result: FileContentResult): void;
  seedFileContent(
    subject: SubjectRevision,
    path: string,
    contentOrResult: string | FileContentResult,
  ): void {
    const result: FileContentResult =
      typeof contentOrResult === "string"
        ? { complete: true, path, content: contentOrResult }
        : contentOrResult;
    this.#fileContent.set(this.#contentKey(subject, path), result);
  }

  async getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]> {
    return this.#files.get(this.#subjectKey(subject)) ?? [];
  }

  async getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]> {
    return this.#rangeFiles.get(this.#rangeKey(range)) ?? [];
  }

  async getFileContent(subject: SubjectRevision, path: string): Promise<FileContentResult> {
    return (
      this.#fileContent.get(this.#contentKey(subject, path)) ?? {
        complete: false,
        path,
        reason: "not_found",
      }
    );
  }

  /** Seed honest candidate-CI evidence for a candidate SHA (tests/harness). */
  seedCandidateCi(subject: SubjectRevision, evidence: CandidateCiEvidence): void {
    this.#candidateCi.set(this.#subjectKey(subject), evidence);
  }

  async getCandidateCi(subject: SubjectRevision): Promise<CandidateCiEvidence> {
    // No seed is a genuinely CI-less candidate (empty records), NOT a failed read:
    // the fake never simulates an API fault. A required context then reads as
    // missing -> the lane is incomplete -> sign-off, exactly as intended.
    return (
      this.#candidateCi.get(this.#subjectKey(subject)) ?? { sha: subject.commitSha, records: [] }
    );
  }

  /** Context-only view over the fake's currently open issues and PRs. */
  async getOpenReleaseWork(repository: string): Promise<RepositoryOpenWorkObservation> {
    const bugIssues = this.#issues
      .filter(
        (issue) =>
          issue.repository === repository &&
          issue.state === "open" &&
          issue.input.labels.some((label) => label.toLowerCase() === "bug"),
      )
      .map((issue) => ({
        number: issue.ref.number,
        url: issue.ref.url,
        title: issue.input.title,
        labels: [...issue.input.labels],
      }))
      .sort((a, b) => a.number - b.number);
    const openPullRequests = [...this.#pullRequests.values()]
      .filter((pr) => pr.repository === repository && pr.state === "open")
      .map((pr) => ({
        number: pr.number,
        url: pr.url,
        title: pr.input.title,
        draft: pr.draft,
        headSha: pr.headSha,
        headBranch: pr.branch,
        baseBranch: pr.input.baseBranch ?? "default",
        author: "scruffy[bot]",
      }))
      .sort((a, b) => a.number - b.number);
    return { complete: true, bugIssues, openPullRequests, gaps: [] };
  }

  async upsertCheckRun(input: CheckRunInput): Promise<CheckRunResult> {
    const key = `${this.#subjectKey(input.subject)}#${input.externalId}`;
    const existing = this.#checkRuns.get(key);
    if (existing) {
      // Idempotent: update the payload in place, keep the id, report not-created.
      this.#checkRuns.set(key, { id: existing.id, input });
      return { id: existing.id, created: false };
    }
    this.#idSeq += 1;
    const id = `check_${this.#idSeq}`;
    this.#checkRuns.set(key, { id, input });
    return { id, created: true };
  }

  /**
   * Mirrors the GitHub adapter's MECHANISM, not just its signature, because the
   * mechanism is what the harness tests are about:
   *
   *  - idempotent on the candidate-bound `externalId`, so a re-dispatch converges
   *    on one PR and a later candidate (different proposal identity) never matches
   *    an earlier one;
   *  - every `expectedOriginal` is verified against seeded content AT THE REVIEWED
   *    SHA, so a stale preimage fails here exactly as it would against GitHub;
   *  - the branch carries the proposal manifest in its commit message, and a
   *    pre-existing branch that does not declare THIS proposal is refused rather
   *    than assumed to already contain the patch;
   *  - `draft` round-trips as provider truth.
   */
  async openPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const existing = this.#pullRequests.get(input.externalId);
    if (existing) {
      // Idempotent: keep the number/head, update the payload, report not-created.
      existing.input = input;
      return {
        number: existing.number,
        url: existing.url,
        headSha: existing.headSha,
        draft: existing.draft,
        created: false,
      };
    }

    const { repository, commitSha } = input.subject;
    const branchKey = `${repository}#${input.branch}`;
    const branch = this.#branches.get(branchKey);
    if (branch !== undefined) {
      if (!commitCarriesProposal(branch.message, input.proposalId)) {
        throw new Error(
          `fake-scm: branch ${input.branch} is at ${branch.sha}, which does not declare fix proposal ${input.proposalId}`,
        );
      }
    } else {
      await this.#verifyPreimages(input);
      const sha = fakeSha(`${input.proposalId}:commit`);
      this.#branches.set(branchKey, {
        sha,
        message: fixCommitMessage({
          title: input.title,
          proposalId: input.proposalId,
          reviewedSha: commitSha,
        }),
      });
    }

    this.#prSeq += 1;
    const number = this.#prSeq;
    const record: FakePullRequest = {
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      headSha: this.#branches.get(branchKey)!.sha,
      draft: input.draft,
      state: "open",
      merged: false,
      mergeCommitSha: null,
      repository,
      branch: input.branch,
      input,
    };
    this.#pullRequests.set(input.externalId, record);
    return { number, url: record.url, headSha: record.headSha, draft: record.draft, created: true };
  }

  /**
   * Check every supplied preimage against content seeded at the REVIEWED sha.
   * A path with no seeded content is a hallucinated path, not an empty file.
   */
  async #verifyPreimages(input: PullRequestInput): Promise<void> {
    for (const edit of input.edits) {
      if (edit.expectedOriginal === undefined) continue;
      const read = await this.getFileContent(input.subject, edit.path);
      if (!read.complete) {
        throw new Error(
          `fake-scm: cannot read ${edit.path} at ${input.subject.commitSha} (${read.reason})`,
        );
      }
      const lines = read.content.split("\n");
      const actual = lines.slice(edit.startLine - 1, edit.endLine).join("\n");
      if (edit.startLine < 1 || edit.endLine > lines.length || actual !== edit.expectedOriginal) {
        throw new Error(
          `fake-scm: preimage mismatch for ${edit.path} lines ${edit.startLine}-${edit.endLine} at ${input.subject.commitSha}`,
        );
      }
    }
  }

  // ── Lifecycle reads + the human/CI actions tests need to simulate ───────────

  async getPullRequest(repository: string, number: number): Promise<PullRequestObservation | null> {
    const record = this.#pull(repository, number);
    if (record === undefined) return null;
    return {
      number: record.number,
      url: record.url,
      headSha: record.headSha,
      draft: record.draft,
      state: record.state,
      merged: record.merged,
      mergeCommitSha: record.merged ? record.mergeCommitSha : null,
    };
  }

  async getCiEvidence(repository: string, sha: string): Promise<CiEvidence> {
    return this.#ci.get(`${repository}@${sha}`) ?? { sha, checkRuns: [], statuses: [] };
  }

  async getBranchHead(repository: string, branch: string): Promise<string | null> {
    return this.#branches.get(`${repository}#${branch}`)?.sha ?? null;
  }

  async getIssueState(
    _repository: string,
    number: number,
  ): Promise<ExternalIssueObservation | null> {
    // An explicitly simulated HUMAN closure wins: it carries an actor and reason,
    // which is exactly what distinguishes a dismissal from Scruffy's own close.
    const closed = this.#issueState.get(number);
    if (closed !== undefined) return closed;
    const known = this.#issues.find((issue) => issue.ref.number === number);
    if (known === undefined) return null;
    return { number, state: known.state, stateReason: null, closedBy: null };
  }

  // ── Installation reader ─────────────────────────────────────────────────────

  /**
   * Seed the repositories the "installation" can see, each with its OWN default
   * branch. Repositories that are not seeded are not installed, which is what lets
   * a scheduler test prove it never reaches outside the installation.
   */
  seedInstalledRepositories(repositories: readonly Partial<InstalledRepository>[]): void {
    this.#installed = repositories.map((repo, index) => ({
      repository: repo.repository ?? `acme/repo-${index}`,
      externalId: repo.externalId ?? String(900_000 + index),
      // NO DEFAULT OF `main`. A test that forgot to say which branch a repository
      // uses must not be silently handed the one name the product is forbidden to
      // assume.
      defaultBranch: repo.defaultBranch ?? `branch-${index}`,
      archived: repo.archived ?? false,
      disabled: repo.disabled ?? false,
    }));
  }

  /**
   * Make the next installation listing FAIL. Mirrors the real adapter's discipline:
   * a fault throws and never degrades into an empty list, because "the installation
   * has no repositories" and "we could not ask" must not look the same to a
   * scheduler.
   */
  failInstallationListing(reason: string): void {
    this.#installationFault = new Error(reason);
  }

  async listInstalledRepositories(): Promise<InstalledRepository[]> {
    this.#installationListings += 1;
    if (this.#installationFault !== null) {
      const fault = this.#installationFault;
      // One-shot, so a test can prove the NEXT tick recovers rather than needing a
      // second fake.
      this.#installationFault = null;
      throw fault;
    }
    if (this.#installed === null) {
      throw new Error(
        "fake-scm: no installed repositories seeded — call seedInstalledRepositories() first",
      );
    }
    return this.#installed.map((repo) => ({ ...repo }));
  }

  async resolveBranchHead(repository: string, branch: string): Promise<string | null> {
    // Same store as `getBranchHead`: one branch head per repository/branch, so a
    // test cannot accidentally seed a scheduler head that disagrees with the head
    // post-merge verification later reads.
    return this.getBranchHead(repository, branch);
  }

  /** How many times the installation listing was read (cadence assertions). */
  installationListingCount(): number {
    return this.#installationListings;
  }

  /** Seed a pre-existing branch (collision/crash-resume cases). */
  seedBranch(repository: string, branch: string, sha: string, message: string): void {
    this.#branches.set(`${repository}#${branch}`, { sha, message });
  }

  /** Seed the repository's CI result for one immutable commit. */
  seedCiEvidence(repository: string, sha: string, evidence: Omit<CiEvidence, "sha">): void {
    this.#ci.set(`${repository}@${sha}`, { sha, ...evidence });
  }

  /** A human (or a push) advances the PR head — the previous head's CI is now stale. */
  advancePullRequestHead(repository: string, number: number, sha: string): void {
    const record = this.#requirePull(repository, number);
    record.headSha = sha;
    this.#branches.set(`${repository}#${record.branch}`, {
      sha,
      message: this.#branches.get(`${repository}#${record.branch}`)?.message ?? "",
    });
  }

  /** A human merges the PR. Scruffy never does this itself. */
  mergePullRequest(repository: string, number: number, mergeCommitSha: string): void {
    const record = this.#requirePull(repository, number);
    record.state = "closed";
    record.merged = true;
    record.mergeCommitSha = mergeCommitSha;
  }

  /** A human closes the PR without merging. */
  closePullRequest(repository: string, number: number): void {
    const record = this.#requirePull(repository, number);
    record.state = "closed";
    record.merged = false;
  }

  /** A human closes the child issue outside Scruffy. */
  closeIssue(number: number, options: { actor?: string; stateReason?: string } = {}): void {
    this.#issueState.set(number, {
      number,
      state: "closed",
      stateReason: options.stateReason ?? null,
      closedBy: options.actor ?? null,
    });
  }

  /** Move a branch head, e.g. to the post-merge candidate. */
  setBranchHead(repository: string, branch: string, sha: string): void {
    const existing = this.#branches.get(`${repository}#${branch}`);
    this.#branches.set(`${repository}#${branch}`, { sha, message: existing?.message ?? "" });
  }

  #pull(repository: string, number: number): FakePullRequest | undefined {
    return [...this.#pullRequests.values()].find(
      (pr) => pr.repository === repository && pr.number === number,
    );
  }

  #requirePull(repository: string, number: number): FakePullRequest {
    const record = this.#pull(repository, number);
    if (record === undefined)
      throw new Error(`fake-scm: no pull request #${number} in ${repository}`);
    return record;
  }

  /**
   * Idempotent on (repository, marker) exactly like the GitHub adapter, so the
   * harness can assert that a re-dispatched publication converges on ONE issue.
   *
   * It mirrors the real MECHANISM rather than shortcutting it: the marker is embedded
   * in the stored BODY and rediscovered by scanning bodies, because that is what the
   * GitHub adapter does and what a crash-resume depends on. A double that keyed a map
   * on the marker directly would keep passing after the adapter stopped embedding it.
   * `knownRef` short-circuits to the update, again like the adapter.
   */
  async upsertIssue(input: IssueUpsertInput): Promise<IssueUpsertResult> {
    const body = withIssueMarker(input.body, input.marker);
    const existing =
      (input.knownRef ? this.#issueByNumber(input.repository, input.knownRef.number) : undefined) ??
      this.#issueByMarker(input.repository, input.marker);
    if (existing) {
      existing.input = { ...input, body };
      // Omitted state leaves the issue exactly as it is — a body refresh must never
      // reopen something a human closed.
      if (input.state !== undefined) existing.state = input.state;
      return { ...existing.ref, created: false };
    }
    this.#issueSeq += 1;
    const ref: IssueUpsertResult = {
      number: this.#issueSeq,
      // Shaped like a GitHub issue DATABASE id — numeric text, unrelated to the
      // number — because that is what the real adapter returns and what the native
      // sub-issue endpoint requires. An `issue_1`-style handle would let a test pass
      // against an id production refuses.
      id: String(500_000 + this.#issueSeq),
      url: `https://github.com/${input.repository}/issues/${this.#issueSeq}`,
      created: true,
    };
    // Never closed on create, whatever the caller asked for: publishing an issue
    // already closed would hide brand-new work from the humans it is meant for.
    this.#issues.push({
      repository: input.repository,
      ref,
      input: { ...input, body },
      state: "open",
    });
    return ref;
  }

  /**
   * Keyed on the child's DATABASE id, like the native endpoint — a fake that keyed on
   * the number would not notice a caller that passed the wrong field.
   */
  async linkChildIssue(input: IssueLinkInput): Promise<IssueLinkResult> {
    const childId = Number(input.child.id);
    if (!Number.isSafeInteger(childId) || childId <= 0) {
      throw new Error(`fake-scm: child issue id '${input.child.id}' is not an issue database id`);
    }
    const key = `${input.repository}#${input.parent.number}`;
    const children = this.#subIssues.get(key) ?? new Map<number, number>();
    const alreadyLinked = children.has(childId);
    children.set(childId, input.child.number);
    this.#subIssues.set(key, children);
    return { alreadyLinked };
  }

  #issueByMarker(repository: string, marker: string): FakeIssue | undefined {
    return this.#issues.find(
      (issue) => issue.repository === repository && issue.input.body.includes(marker),
    );
  }

  #issueByNumber(repository: string, number: number): FakeIssue | undefined {
    return this.#issues.find(
      (issue) => issue.repository === repository && issue.ref.number === number,
    );
  }

  /** Test/harness introspection. */
  recordedCheckRuns(): { id: string; input: CheckRunInput }[] {
    return [...this.#checkRuns.values()];
  }

  recordedPullRequests(): FakePullRequest[] {
    return [...this.#pullRequests.values()];
  }

  recordedIssues(): FakeIssue[] {
    return [...this.#issues];
  }

  /**
   * Parent issue number -> attached child issue NUMBERS (the readable handle), even
   * though attachment is stored by database id. Issue numbers are unique across
   * repositories in the fake, so collapsing the repository out of the key here cannot
   * merge two parents.
   */
  recordedSubIssues(): Map<number, number[]> {
    return new Map(
      [...this.#subIssues].map(([key, children]) => [
        Number(key.split("#").pop()),
        [...children.values()].sort((a, b) => a - b),
      ]),
    );
  }

  #subjectKey(subject: SubjectRevision): string {
    return `${subject.repository}@${subject.commitSha}`;
  }

  #rangeKey(range: RevisionRange): string {
    return `${range.repository}@${range.baseSha ?? "∅"}..${range.headSha}`;
  }

  #contentKey(subject: SubjectRevision, path: string): string {
    return `${this.#subjectKey(subject)}::${path}`;
  }
}

/**
 * A deterministic 40-hex sha for a seed string. Shaped like a real git sha
 * because the domain schemas require one — a `sha_1`-style handle would let a
 * test pass against an identity production would reject.
 */
export function fakeSha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 40);
}
