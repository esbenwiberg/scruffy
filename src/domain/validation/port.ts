import type { Finding, ValidationOutcome } from "../evidence/types.js";

/**
 * Adversarial validation. A validator's job is to try to REFUTE a candidate
 * finding using independent evidence — not to ask the same model to repeat its
 * judgment (heritage assessment).
 *
 * Contract for failure semantics (critical): if validation cannot run, the
 * validator returns `failed` or `indeterminate`. It must never fabricate
 * `validated`. The poison kernel treats those as abstain, so infra failure can
 * never become a silent allow or an unearned block.
 */
export interface Validator {
  readonly id: string;
  validate(finding: Finding): Promise<ValidationOutcome>;
}
