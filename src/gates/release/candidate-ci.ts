import type { LaneStatus } from "../../domain/release/report.js";
import { RELEASE_SELF_CONTEXT } from "../../domain/policy/types.js";
import type { CandidateCiEvidence, CandidateCiRecord, CandidateCiState } from "../../providers/scm/port.js";

/**
 * Pure evaluation of the candidate-CI evidence lane. Given the service-owned lane
 * declaration and the normalized evidence a reader gathered for the EXACT candidate
 * SHA, decide whether the lane is complete and produce its report status, human
 * observations, and explicit gaps.
 *
 * The lane is `complete` only when EVERY policy-named required context is present
 * for the exact candidate and resolves to a single, unambiguous `success`. Anything
 * else — a missing context, a non-success/pending/malformed state, wrong-SHA
 * evidence, or an ambiguous duplicate with no clear latest — leaves the lane
 * incomplete, which the decision kernel escalates to sign-off. Extra unrelated
 * contexts never substitute for, nor hold, a required one. The gate's own
 * `scruffy/release` context is IGNORED here to avoid a self-dependency (policy
 * parsing already rejects it as a required context).
 */

export interface CandidateCiDeclaration {
  applicable: boolean;
  required: boolean;
  requiredContexts: readonly string[];
}

export interface CandidateCiEvaluation {
  applicable: boolean;
  required: boolean;
  /**
   * Whether the lane is satisfied for the purposes of `ship`. `not-applicable`
   * lanes are complete (they do not hold). Feeds the decision kernel.
   */
  complete: boolean;
  status: LaneStatus;
  observations: string[];
  gaps: string[];
}

export function evaluateCandidateCi(
  candidateSha: string,
  ci: CandidateCiDeclaration,
  evidence: CandidateCiEvidence | null,
  readError: string | null,
): CandidateCiEvaluation {
  if (!ci.applicable) {
    return {
      applicable: false,
      required: false,
      complete: true,
      status: "not-applicable",
      observations: ["Candidate CI is not applicable under this release policy."],
      gaps: [],
    };
  }

  // An applicable lane whose read FAILED is a failed lane — never an empty success.
  if (readError !== null || evidence === null) {
    return {
      applicable: true,
      required: ci.required,
      complete: false,
      status: "failed",
      observations: ["Candidate CI evidence could not be read for the candidate."],
      gaps: [`candidate CI read failed: ${readError ?? "no evidence returned"}`],
    };
  }

  // Bind to the EXACT candidate: drop the self-context and any wrong-SHA record so
  // a required context backed only by wrong-SHA evidence reads as missing.
  const relevant = evidence.records.filter((r) => r.context !== RELEASE_SELF_CONTEXT && r.sha === candidateSha);
  const byContext = new Map<string, CandidateCiRecord[]>();
  for (const record of relevant) {
    const group = byContext.get(record.context) ?? [];
    group.push(record);
    byContext.set(record.context, group);
  }

  const observations: string[] = [`Required CI contexts (${ci.requiredContexts.length}): ${ci.requiredContexts.join(", ")}.`];
  const gaps: string[] = [];

  for (const context of ci.requiredContexts) {
    const records = byContext.get(context);
    if (records === undefined || records.length === 0) {
      gaps.push(`required CI context "${context}" is missing for the candidate`);
      continue;
    }
    const resolved = resolveLatest(records);
    if (resolved.ambiguous) {
      gaps.push(`required CI context "${context}" has ambiguous duplicate records with no clear latest`);
      continue;
    }
    if (resolved.state !== "success") {
      gaps.push(`required CI context "${context}" is "${resolved.state}", not a successful terminal state`);
      continue;
    }
    observations.push(`context "${context}" passed for the candidate.`);
  }

  const complete = gaps.length === 0;
  return {
    applicable: true,
    required: ci.required,
    complete,
    status: complete ? "complete" : "partial",
    observations,
    gaps,
  };
}

/**
 * Resolve possibly-duplicate records for ONE context to a single state. Agreement
 * is unambiguous even without timestamps. Disagreement needs a CLEAR latest under
 * provider ordering (`updatedAt`): a unique newest record wins; a missing timestamp
 * or a tie between differing states is ambiguous and resolved conservatively.
 */
function resolveLatest(records: CandidateCiRecord[]): { state: CandidateCiState; ambiguous: false } | { ambiguous: true } {
  const states = new Set(records.map((r) => r.state));
  if (states.size === 1) return { state: records[0]!.state, ambiguous: false };

  // Differing states: without a timestamp on every record there is no clear latest.
  if (records.some((r) => r.updatedAt === undefined)) return { ambiguous: true };

  const sorted = [...records].sort((a, b) => (a.updatedAt! < b.updatedAt! ? 1 : a.updatedAt! > b.updatedAt! ? -1 : 0));
  const newest = sorted[0]!.updatedAt!;
  const tiedAtNewest = sorted.filter((r) => r.updatedAt === newest);
  if (tiedAtNewest.length > 1 && new Set(tiedAtNewest.map((r) => r.state)).size > 1) {
    // Two different states share the newest timestamp — no clear latest.
    return { ambiguous: true };
  }
  return { state: sorted[0]!.state, ambiguous: false };
}
