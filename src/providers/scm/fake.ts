import type { SubjectRevision } from "../../domain/evidence/types.js";
import type {
  ChangedFile,
  CheckRunInput,
  CheckRunResult,
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
  #idSeq = 0;

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

  /** Test/harness introspection. */
  recordedCheckRuns(): { id: string; input: CheckRunInput }[] {
    return [...this.#checkRuns.values()];
  }

  #subjectKey(subject: SubjectRevision): string {
    return `${subject.repository}@${subject.commitSha}`;
  }

  #rangeKey(range: RevisionRange): string {
    return `${range.repository}@${range.baseSha ?? "∅"}..${range.headSha}`;
  }
}
