import { createHash } from "node:crypto";
import type { SubjectRevision } from "../../domain/evidence/types.js";
import type {
  ChangedFile,
  CheckRunInput,
  CheckRunResult,
  ExternalIssueObservation,
  FileContentResult,
  IssueLinkInput,
  IssueLinkResult,
  IssueUpsertInput,
  IssueUpsertResult,
  PullRequestInput,
  PullRequestResult,
  RevisionRange,
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

export class FakeScm implements ScmReader, ScmWriter, ScmLifecycleReader {
  readonly #files = new Map<string, ChangedFile[]>();
  readonly #rangeFiles = new Map<string, ChangedFile[]>();
  readonly #fileContent = new Map<string, FileContentResult>();
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
  seedFileContent(subject: SubjectRevision, path: string, contentOrResult: string | FileContentResult): void {
    const result: FileContentResult =
      typeof contentOrResult === "string" ? { complete: true, path, content: contentOrResult } : contentOrResult;
    this.#fileContent.set(this.#contentKey(subject, path), result);
  }

  async getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]> {
    return this.#files.get(this.#subjectKey(subject)) ?? [];
  }

  async getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]> {
    return this.#rangeFiles.get(this.#rangeKey(range)) ?? [];
  }

  async getFileContent(subject: SubjectRevision, path: string): Promise<FileContentResult> {
    return this.#fileContent.get(this.#contentKey(subject, path)) ?? { complete: false, path, reason: "not_found" };
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
      return { number: existing.number, url: existing.url, headSha: existing.headSha, draft: existing.draft, created: false };
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
        message: fixCommitMessage({ title: input.title, proposalId: input.proposalId, reviewedSha: commitSha }),
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
        throw new Error(`fake-scm: cannot read ${edit.path} at ${input.subject.commitSha} (${read.reason})`);
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

  async getIssueState(_repository: string, number: number): Promise<ExternalIssueObservation | null> {
    const closed = this.#issueState.get(number);
    if (closed !== undefined) return closed;
    const known = this.#issues.some((issue) => issue.ref.number === number);
    return known ? { number, state: "open", stateReason: null, closedBy: null } : null;
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
    return [...this.#pullRequests.values()].find((pr) => pr.repository === repository && pr.number === number);
  }

  #requirePull(repository: string, number: number): FakePullRequest {
    const record = this.#pull(repository, number);
    if (record === undefined) throw new Error(`fake-scm: no pull request #${number} in ${repository}`);
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
    this.#issues.push({ repository: input.repository, ref, input: { ...input, body } });
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
    return this.#issues.find((issue) => issue.repository === repository && issue.input.body.includes(marker));
  }

  #issueByNumber(repository: string, number: number): FakeIssue | undefined {
    return this.#issues.find((issue) => issue.repository === repository && issue.ref.number === number);
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
