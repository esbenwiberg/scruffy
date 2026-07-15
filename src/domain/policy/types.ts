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

export const EffectivePolicy = z.object({
  /** Immutable version identity; every decision cites this. */
  version: z.string().min(1),
  poison: PoisonPolicy,
});
export type EffectivePolicy = z.infer<typeof EffectivePolicy>;
