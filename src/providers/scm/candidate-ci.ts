import type { CandidateCiState } from "./port.js";

/**
 * Shared candidate-CI normalization, reused by every real SCM adapter (gh-cli and
 * the GitHub App reader) so the two transports collapse GitHub's two DIFFERENT
 * status vocabularies onto one `CandidateCiState` identically. Kept pure and
 * transport-free: the adapters own the reads, this owns the mapping.
 *
 * The load-bearing rule: only an unambiguous, terminal PASS is `success`. Anything
 * else — non-terminal, cancelled/timed-out/neutral/action-required, an errored
 * status, or a value GitHub could add tomorrow — normalizes to a NON-success state
 * so it can never be read as clean.
 */

/**
 * Normalize a GitHub check-run (`status` + `conclusion`) to a `CandidateCiState`.
 * A check run is only meaningful once `status === "completed"`; anything else is
 * still running/queued -> `pending`. A completed run with a missing or unrecognized
 * conclusion is `unknown` (malformed — not clean), never silently a pass.
 */
export function normalizeCheckRunConclusion(status: string, conclusion: string | null | undefined): CandidateCiState {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed-out";
    case "neutral":
      return "neutral";
    case "action_required":
      return "action-required";
    // `skipped` did not run to a pass; treat it as neutral (not clean), not success.
    case "skipped":
      return "neutral";
    // `stale` and anything unrecognized (incl. null on a "completed" run) are blind.
    default:
      return "unknown";
  }
}

/** Normalize a GitHub commit-status `state` to a `CandidateCiState`. */
export function normalizeCommitStatusState(state: string): CandidateCiState {
  switch (state) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "error":
      return "error";
    case "pending":
      return "pending";
    default:
      return "unknown";
  }
}
