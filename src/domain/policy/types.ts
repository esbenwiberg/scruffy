import { z } from "zod";

/**
 * Effective policy is service-owned and immutable per version (ADR 0001). The
 * reviewed repository cannot supply or weaken it. A gate decision always records
 * which policy version produced it.
 *
 * This is the minimal slice the poison gate needs for the walking skeleton;
 * nightly and release policy will extend it.
 */

export const PoisonPolicy = z.object({
  /**
   * Defect classes the poison gate is permitted to block on. A finding whose
   * class is not listed here can never block — it falls through to a deeper
   * gate. This is how "protect only what can justify blocking" is enforced.
   */
  blockableDefectClasses: z.array(z.string().min(1)).readonly(),
  /**
   * Whether a block additionally requires affirmative adversarial validation.
   * Kept as policy (not hardcoded) so shadow mode can tighten it over time.
   */
  requireValidation: z.boolean(),
});
export type PoisonPolicy = z.infer<typeof PoisonPolicy>;

/**
 * Nightly-gate policy. The nightly gate never blocks; it proposes. Its decision
 * is a per-finding disposition, so policy carves the finding space into what is
 * worth surfacing at all and what is additionally eligible for an automated fix.
 */
export const NightlyPolicy = z.object({
  /**
   * Defect classes worth surfacing as a nightly finding. A class not listed here
   * is suppressed — recorded, but not reported for human attention.
   */
  reportableDefectClasses: z.array(z.string().min(1)).readonly(),
  /**
   * Subset of reportable classes eligible for an automated fix PR. A finding only
   * becomes `propose_fix` when it is additionally validated and deterministically
   * supported (see the nightly kernel). Fix *generation* is a later slice; this
   * slice records the disposition. Every fixable class MUST also be reportable.
   */
  fixableDefectClasses: z.array(z.string().min(1)).readonly(),
});
export type NightlyPolicy = z.infer<typeof NightlyPolicy>;

/**
 * Release-gate policy. The release gate is the LAST gate before publication —
 * it has no deeper gate to escalate to, only a human. Its decision over the whole
 * (prev-release, candidate] range is one aggregate outcome:
 * `ship | sign-off-required | stop`. Policy carves the finding space by
 * REVERSIBILITY:
 *  - `stopDefectClasses`: irreversible catastrophes (a burned secret, lost data).
 *    A CONFIRMED one hard-stops the release. Unconfirmed → human sign-off, never a
 *    fabricated stop.
 *  - `signoffDefectClasses`: serious but human-adjudicable regressions. Any
 *    surfaced (non-refuted) one forces sign-off-required.
 * A class in neither list is release-irrelevant. If a class appears in both, the
 * more severe `stop` treatment wins (see the kernel). Keep the lists disjoint.
 */
export const ReleasePolicy = z.object({
  /** Confirmed finding of one of these hard-stops the release (irreversible harm). */
  stopDefectClasses: z.array(z.string().min(1)).readonly(),
  /** A surfaced finding of one of these forces human sign-off before release. */
  signoffDefectClasses: z.array(z.string().min(1)).readonly(),
});
export type ReleasePolicy = z.infer<typeof ReleasePolicy>;

export const EffectivePolicy = z.object({
  /** Immutable version identity; every decision cites this. */
  version: z.string().min(1),
  poison: PoisonPolicy,
  nightly: NightlyPolicy,
  release: ReleasePolicy,
});
export type EffectivePolicy = z.infer<typeof EffectivePolicy>;
