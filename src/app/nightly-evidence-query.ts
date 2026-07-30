import {
  summarizeNightlyEvidence,
  type NightlyEvidenceQueryInput,
  type NightlyEvidenceReadPort,
  type NightlyEvidenceSnapshot,
} from "../domain/findings/nightly-evidence.js";

/**
 * The application-level nightly EVIDENCE query.
 *
 * A thin, read-only lens over `persistence/nightly-evidence.ts`, kept separate from
 * it so the shape a later release-report aggregation consumes is a
 * provider-and-storage-neutral port rather than a Postgres row. The port carries no
 * mutating method, and this class adds none: aggregation may OBSERVE the nightly fix
 * lifecycle and can never advance, resolve, or dismiss anything through it.
 *
 * Explicitly NOT a release authority. Nothing here decides a release outcome, and
 * `gates/release/` neither imports this module nor consumes its snapshots — the
 * release gate, its report contract, and the active release campaign boundary are
 * unchanged by this brief.
 */

export type {
  NightlyEvidenceFinding,
  NightlyEvidenceQueryInput,
  NightlyEvidenceReadPort,
  NightlyEvidenceReport,
  NightlyEvidenceSnapshot,
} from "../domain/findings/nightly-evidence.js";
export { summarizeNightlyEvidence } from "../domain/findings/nightly-evidence.js";

const DEFAULT_LIMIT = 20;

export class NightlyEvidenceQuery {
  constructor(private readonly reader: NightlyEvidenceReadPort) {}

  /** Nightly evidence for a repository (optionally narrowed to one branch). */
  async forRepository(input: NightlyEvidenceQueryInput): Promise<NightlyEvidenceSnapshot> {
    const reports = await this.reader.reports({ ...input, limit: input.limit ?? DEFAULT_LIMIT });
    return summarizeNightlyEvidence(
      { repository: input.repository, branch: input.branch ?? null, candidateSha: input.candidateSha ?? null },
      reports,
    );
  }

  /**
   * Nightly evidence for one immutable candidate. A release aggregation asks this;
   * it gets an empty snapshot with `requiredCoverageComplete: false` when nightly
   * never completely reviewed that candidate, because "no evidence" must never read
   * as "reviewed and clean".
   */
  async forCandidate(repository: string, candidateSha: string, limit = DEFAULT_LIMIT): Promise<NightlyEvidenceSnapshot> {
    return this.forRepository({ repository, candidateSha, limit });
  }
}
