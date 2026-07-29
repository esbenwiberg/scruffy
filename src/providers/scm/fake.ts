import type { SubjectRevision } from "../../domain/evidence/types.js";
import type {
  ChangedFile,
  CheckRunInput,
  CheckRunResult,
  FileContentResult,
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
import { withIssueMarker } from "../../domain/findings/work-publication.js";

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
export class FakeScm implements ScmReader, ScmWriter {
  readonly #files = new Map<string, ChangedFile[]>();
  readonly #rangeFiles = new Map<string, ChangedFile[]>();
  readonly #fileContent = new Map<string, FileContentResult>();
  readonly #checkRuns = new Map<string, { id: string; input: CheckRunInput }>();
  readonly #pullRequests = new Map<string, { number: number; input: PullRequestInput }>();
  readonly #issues: FakeIssue[] = [];
  /** `repository#parentNumber` -> child database id -> child number. */
  readonly #subIssues = new Map<string, Map<number, number>>();
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

  recordedPullRequests(): { number: number; input: PullRequestInput }[] {
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
