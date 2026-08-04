import {
  RELEASE_CONFIG_PATH,
  type RepositoryReleaseConfigParse,
  type RepositoryReleaseConfigV1,
} from "./repository-config.js";

/**
 * Pure release-authority baseline/change assessment.
 *
 * Given the parsed candidate configuration, the previous release's already-validated
 * configuration (if any), and the exact authority-relevant paths that changed across
 * the immutable `(previousReleaseSha, candidateSha]` range, decide whether the
 * release-authority lane is clean, requires a protected sign-off, or is ineligible.
 *
 * This kernel owns SEMANTICS; it performs no IO. Its inputs are gathered by the
 * gate-level orchestration, which does the reads. Determinism is the contract: the
 * same inputs always yield the same assessment.
 *
 * Rules (service-owned; the repository only supplied a path list):
 *  1. An invalid candidate configuration (missing/malformed/empty/self-referential)
 *     is authorization-INELIGIBLE. It is NOT an exception-approvable failure and NOT
 *     a baseline sign-off route — you cannot approve what you cannot read.
 *  2. First adoption — no previous release, or no readable/valid previous
 *     configuration — requires a mandatory baseline sign-off.
 *  3. Any change under the authority paths (`.github/scruffy-release.yml`,
 *     `.github/workflows/**`, `.github/actions/**`) OR a semantic configuration
 *     change forces sign-off, even when the current workflow runs are green.
 *  4. Otherwise the lane is clean and the normal Scruffy decision proceeds.
 *
 * Configuration changes and authority-path changes are EXCEPTION reasons, not hard
 * stops: a confirmed Scruffy `stop` still dominates, but that is decided elsewhere.
 */

/** Path prefixes whose contents constitute release/workflow authority. */
export const AUTHORITY_PATH_PREFIXES = [".github/workflows/", ".github/actions/"] as const;

/** True when a changed repository path affects release or workflow authority. */
export function isAuthorityPath(path: string): boolean {
  if (path === RELEASE_CONFIG_PATH) return true;
  return AUTHORITY_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Keep only the authority-relevant paths from a range's changed-file set, sorted and
 * de-duplicated. Unrelated source changes (e.g. `src/**`) are dropped here, so they
 * can never manufacture an authority change.
 */
export function selectChangedAuthorityPaths(paths: Iterable<string>): string[] {
  const kept = new Set<string>();
  for (const path of paths) {
    if (isAuthorityPath(path)) kept.add(path);
  }
  return [...kept].sort();
}

export type ReleaseAuthorityOutcome = "clean" | "sign-off-required" | "ineligible";

export type ReleaseAuthorityReasonCode =
  | "authority_unchanged"
  | "release_authority_baseline_required"
  | "release_authority_changed"
  | "release_config_missing"
  | "release_config_invalid";

/** A validated configuration paired with its content digest. */
export interface ReleaseConfigIdentity {
  config: RepositoryReleaseConfigV1;
  digest: string;
}

export interface ReleaseAuthorityAssessment {
  outcome: ReleaseAuthorityOutcome;
  reasonCode: ReleaseAuthorityReasonCode;
  /** No previous release, or no readable/valid previous configuration. */
  firstAdoption: boolean;
  /** Candidate configuration is semantically different from the previous baseline. */
  configChanged: boolean;
  /** Exact authority paths that changed in the range, sorted. */
  changedAuthorityPaths: string[];
  /** Required workflows present in the candidate but not the previous baseline. */
  addedRequiredWorkflows: string[];
  /** Required workflows present in the previous baseline but not the candidate. */
  removedRequiredWorkflows: string[];
  /** The candidate configuration identity, or null when the candidate is invalid. */
  candidate: ReleaseConfigIdentity | null;
  /** The previous baseline configuration identity, or null on first adoption. */
  previous: ReleaseConfigIdentity | null;
  detail: string;
}

export interface ReleaseAuthorityInput {
  /** Whether a previous release SHA exists to anchor the comparison baseline. */
  previousReleaseExists: boolean;
  /** Parsed candidate configuration read at the exact candidate SHA. */
  candidate: RepositoryReleaseConfigParse;
  /**
   * The previous release's configuration, ALREADY validated by the orchestration.
   * `null` means there is no previous release, or its configuration was absent,
   * unreadable, or invalid — all of which are handled as "no baseline yet".
   */
  previous: ReleaseConfigIdentity | null;
  /** Authority paths that changed in `(previousReleaseSha, candidateSha]`. */
  changedAuthorityPaths: readonly string[];
  /**
   * Set when the range's changed files could not be read completely. An unverifiable
   * range cannot prove "unchanged", so it conservatively forces sign-off rather than
   * shipping clean. Defaults to verifiable.
   */
  authorityRangeUnverifiable?: boolean;
}

/** Map a candidate parse failure to the authority-level ineligibility reason. */
function candidateIneligibility(candidate: Extract<RepositoryReleaseConfigParse, { ok: false }>): {
  reasonCode: ReleaseAuthorityReasonCode;
  detail: string;
} {
  // "empty" and a hard read-miss are absence; everything else is malformed content.
  // Both are ineligible — the distinction is only for reporting.
  if (candidate.code === "empty") {
    return {
      reasonCode: "release_config_missing",
      detail: `candidate ${RELEASE_CONFIG_PATH} is absent or empty: ${candidate.detail}`,
    };
  }
  return {
    reasonCode: "release_config_invalid",
    detail: `candidate ${RELEASE_CONFIG_PATH} is invalid (${candidate.code}): ${candidate.detail}`,
  };
}

export function assessReleaseAuthority(input: ReleaseAuthorityInput): ReleaseAuthorityAssessment {
  const changedAuthorityPaths = [...new Set(input.changedAuthorityPaths)].sort();

  // (1) An unreadable/invalid candidate configuration is ineligible — never an
  // approvable exception, never a baseline route. This dominates every other signal.
  if (!input.candidate.ok) {
    const { reasonCode, detail } = candidateIneligibility(input.candidate);
    return {
      outcome: "ineligible",
      reasonCode,
      firstAdoption: !input.previousReleaseExists || input.previous === null,
      configChanged: false,
      changedAuthorityPaths,
      addedRequiredWorkflows: [],
      removedRequiredWorkflows: [],
      candidate: null,
      previous: input.previous,
      detail,
    };
  }

  const candidate: ReleaseConfigIdentity = {
    config: input.candidate.config,
    digest: input.candidate.digest,
  };
  const previous = input.previous;
  const firstAdoption = !input.previousReleaseExists || previous === null;

  const candidateWorkflows = new Set(candidate.config.requiredWorkflows);
  const previousWorkflows = new Set(previous?.config.requiredWorkflows ?? []);
  const addedRequiredWorkflows = [...candidateWorkflows]
    .filter((w) => !previousWorkflows.has(w))
    .sort();
  const removedRequiredWorkflows = [...previousWorkflows]
    .filter((w) => !candidateWorkflows.has(w))
    .sort();
  const configChanged = previous !== null && previous.digest !== candidate.digest;

  // (2) First adoption — establish a baseline through mandatory sign-off.
  if (firstAdoption) {
    return {
      outcome: "sign-off-required",
      reasonCode: "release_authority_baseline_required",
      firstAdoption: true,
      configChanged: false,
      changedAuthorityPaths,
      addedRequiredWorkflows,
      removedRequiredWorkflows,
      candidate,
      previous,
      detail: input.previousReleaseExists
        ? "no readable previous release configuration; sign-off required to establish a baseline"
        : "first release; sign-off required to establish a baseline",
    };
  }

  // (3) Any authority-path or semantic-configuration change forces sign-off.
  const rangeUnverifiable = input.authorityRangeUnverifiable === true;
  if (configChanged || changedAuthorityPaths.length > 0 || rangeUnverifiable) {
    const parts: string[] = [];
    if (configChanged) parts.push("release configuration changed");
    if (changedAuthorityPaths.length > 0)
      parts.push(`authority paths changed: ${changedAuthorityPaths.join(", ")}`);
    if (rangeUnverifiable) parts.push("authority range could not be verified as unchanged");
    return {
      outcome: "sign-off-required",
      reasonCode: "release_authority_changed",
      firstAdoption: false,
      configChanged,
      changedAuthorityPaths,
      addedRequiredWorkflows,
      removedRequiredWorkflows,
      candidate,
      previous,
      detail: parts.join("; "),
    };
  }

  // (4) Clean: an established baseline, unchanged authority, unchanged configuration.
  return {
    outcome: "clean",
    reasonCode: "authority_unchanged",
    firstAdoption: false,
    configChanged: false,
    changedAuthorityPaths,
    addedRequiredWorkflows,
    removedRequiredWorkflows,
    candidate,
    previous,
    detail: "release authority unchanged since the previous baseline",
  };
}
