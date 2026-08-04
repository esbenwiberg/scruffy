import type { ScmReader, RevisionRange } from "../../providers/scm/port.js";
import {
  parseRepositoryReleaseConfig,
  RELEASE_CONFIG_PATH,
  type RepositoryReleaseConfigParse,
} from "../../domain/release/repository-config.js";
import {
  assessReleaseAuthority,
  selectChangedAuthorityPaths,
  type ReleaseAuthorityAssessment,
  type ReleaseConfigIdentity,
} from "../../domain/release/authority-change.js";

/**
 * Gate-level orchestration for the release-authority lane. This is the IO seam: it
 * reads the repository release configuration at the EXACT candidate SHA, the previous
 * release's configuration when a previous release exists, and the authority-relevant
 * files that changed across the immutable range — then delegates every semantic
 * judgement to the pure `assessReleaseAuthority` kernel.
 *
 * Provider facts (repository identity, changed paths, file content) come only from
 * the `ScmReader`; nothing here is taken from repository content or request input
 * beyond the SHAs it was asked about. Reads fail closed: a candidate configuration
 * that cannot be read completely is treated as absent (ineligible), and a range that
 * cannot be read is treated as unverifiable (forces sign-off), never as "unchanged".
 */

export interface ReleaseAuthorityRange {
  /** `owner/name`. */
  repository: string;
  /** Full 40-char candidate SHA the release is proposed for. */
  candidateSha: string;
  /** Full 40-char previous release SHA, or null for the first release. */
  previousReleaseSha: string | null;
}

/**
 * Read one repository configuration file at an immutable revision and parse it. A
 * read that is not served completely (missing, binary, oversized, provider fault)
 * becomes a parse-level `empty` result: from the release-authority contract's point
 * of view there is no readable configuration, which is ineligible — never silently
 * treated as a green baseline.
 */
async function readConfigAt(
  scm: ScmReader,
  repository: string,
  commitSha: string,
): Promise<RepositoryReleaseConfigParse> {
  let read;
  try {
    read = await scm.getFileContent({ repository, commitSha }, RELEASE_CONFIG_PATH);
  } catch (error) {
    return {
      ok: false,
      code: "empty",
      detail: `could not read ${RELEASE_CONFIG_PATH}: ${error instanceof Error ? error.message : "read failed"}`,
    };
  }
  if (!read.complete) {
    return {
      ok: false,
      code: "empty",
      detail: `${RELEASE_CONFIG_PATH} could not be read completely (${read.reason})`,
    };
  }
  return parseRepositoryReleaseConfig(read.content);
}

export async function evaluateReleaseAuthority(
  range: ReleaseAuthorityRange,
  scm: ScmReader,
): Promise<ReleaseAuthorityAssessment> {
  const candidate = await readConfigAt(scm, range.repository, range.candidateSha);

  // Only a valid previous configuration establishes a baseline. Anything else
  // (no previous release, unreadable, or invalid) leaves `previous` null, which the
  // kernel reads as first adoption -> baseline sign-off.
  let previous: ReleaseConfigIdentity | null = null;
  if (range.previousReleaseSha !== null) {
    const previousParse = await readConfigAt(scm, range.repository, range.previousReleaseSha);
    if (previousParse.ok) {
      previous = { config: previousParse.config, digest: previousParse.digest };
    }
  }

  // Changed authority paths across (previousReleaseSha, candidateSha]. A range read
  // failure cannot prove the authority was unchanged, so it is marked unverifiable.
  let changedAuthorityPaths: string[] = [];
  let authorityRangeUnverifiable = false;
  const revisionRange: RevisionRange = {
    repository: range.repository,
    baseSha: range.previousReleaseSha,
    headSha: range.candidateSha,
  };
  try {
    const files = await scm.getChangedFilesInRange(revisionRange);
    changedAuthorityPaths = selectChangedAuthorityPaths(files.map((f) => f.path));
  } catch {
    authorityRangeUnverifiable = true;
  }

  return assessReleaseAuthority({
    previousReleaseExists: range.previousReleaseSha !== null,
    candidate,
    previous,
    changedAuthorityPaths,
    authorityRangeUnverifiable,
  });
}
