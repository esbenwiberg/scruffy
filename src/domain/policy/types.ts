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

export const EffectivePolicy = z.object({
  /** Immutable version identity; every decision cites this. */
  version: z.string().min(1),
  poison: PoisonPolicy,
  nightly: NightlyPolicy,
});
export type EffectivePolicy = z.infer<typeof EffectivePolicy>;
