import type { SubjectRevision } from "../../domain/evidence/types.js";
import type {
  ChangedFile,
  CheckRunInput,
  CheckRunResult,
  IssueLinkInput,
  IssueLinkResult,
  IssueUpsertInput,
  IssueUpsertResult,
  PullRequestInput,
  PullRequestResult,
  RevisionRange,
  ScmReader,
  ScmWriter,
} from "./port.js";

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
export class FakeScm implements ScmReader, ScmWriter {
  readonly #files = new Map<string, ChangedFile[]>();
  readonly #rangeFiles = new Map<string, ChangedFile[]>();
  readonly #checkRuns = new Map<string, { id: string; input: CheckRunInput }>();
  readonly #pullRequests = new Map<string, { number: number; input: PullRequestInput }>();
  readonly #issues = new Map<string, { ref: IssueUpsertResult; input: IssueUpsertInput }>();
  readonly #subIssues = new Map<number, Set<number>>();
  #idSeq = 0;
  #prSeq = 0;
  #issueSeq = 0;

  seedChangedFiles(subject: SubjectRevision, files: ChangedFile[]): void {
    this.#files.set(this.#subjectKey(subject), files);
  }

  seedChangedFilesInRange(range: RevisionRange, files: ChangedFile[]): void {
    this.#rangeFiles.set(this.#rangeKey(range), files);
  }

  async getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]> {
    return this.#files.get(this.#subjectKey(subject)) ?? [];
  }

  async getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]> {
    return this.#rangeFiles.get(this.#rangeKey(range)) ?? [];
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

  async openPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const existing = this.#pullRequests.get(input.externalId);
    if (existing) {
      // Idempotent: keep the number, update the payload, report not-created.
      this.#pullRequests.set(input.externalId, { number: existing.number, input });
      return { number: existing.number, created: false };
    }
    this.#prSeq += 1;
    const number = this.#prSeq;
    this.#pullRequests.set(input.externalId, { number, input });
    return { number, created: true };
  }

  /**
   * Idempotent on (repository, marker) exactly like the GitHub adapter, so the
   * harness can assert that a re-dispatched publication converges on ONE issue.
   */
  async upsertIssue(input: IssueUpsertInput): Promise<IssueUpsertResult> {
    const key = `${input.repository}#${input.marker}`;
    const existing = this.#issues.get(key);
    if (existing) {
      this.#issues.set(key, { ref: existing.ref, input });
      return { ...existing.ref, created: false };
    }
    this.#issueSeq += 1;
    const ref: IssueUpsertResult = {
      number: this.#issueSeq,
      id: `issue_${this.#issueSeq}`,
      url: `https://github.com/${input.repository}/issues/${this.#issueSeq}`,
      created: true,
    };
    this.#issues.set(key, { ref, input });
    return ref;
  }

  async linkChildIssue(input: IssueLinkInput): Promise<IssueLinkResult> {
    const children = this.#subIssues.get(input.parent.number) ?? new Set<number>();
    const alreadyLinked = children.has(input.child.number);
    children.add(input.child.number);
    this.#subIssues.set(input.parent.number, children);
    return { alreadyLinked };
  }

  /** Test/harness introspection. */
  recordedCheckRuns(): { id: string; input: CheckRunInput }[] {
    return [...this.#checkRuns.values()];
  }

  recordedPullRequests(): { number: number; input: PullRequestInput }[] {
    return [...this.#pullRequests.values()];
  }

  recordedIssues(): { ref: IssueUpsertResult; input: IssueUpsertInput }[] {
    return [...this.#issues.values()];
  }

  /** Parent issue number -> attached child issue numbers. */
  recordedSubIssues(): Map<number, number[]> {
    return new Map([...this.#subIssues].map(([parent, children]) => [parent, [...children].sort((a, b) => a - b)]));
  }

  #subjectKey(subject: SubjectRevision): string {
    return `${subject.repository}@${subject.commitSha}`;
  }

  #rangeKey(range: RevisionRange): string {
    return `${range.repository}@${range.baseSha ?? "∅"}..${range.headSha}`;
  }
}
